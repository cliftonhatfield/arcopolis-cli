import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CredentialStore,
  atomicWriteFile,
  defaultConfig,
  displayPath,
  effectiveWritePolicy,
  emptyCredentials,
  inspectStoreLocation,
  parseConfig,
  resolveCredentials,
  resolveStorePaths,
  withFileLock,
  type CredentialsFile,
  type ProfileRecord,
} from "../src/core/credentials.js";
import { CliError } from "../src/core/errors.js";
import { ensureGitignore } from "../src/core/gitignore.js";
import { fakeKey, run, tempDir } from "./helpers.js";

const posix = process.platform !== "win32";

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await cleanup();
});

function modeOf(value: number): number {
  return value & 0o777;
}

function profile(overrides: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    apiBase: "https://api.arcopolis.ai/v1",
    readKey: { key: fakeKey("1"), origin: "https://api.arcopolis.ai", savedAt: "2026-09-22T00:00:00.000Z" },
    visitor: {
      agentId: "visitor_store",
      key: fakeKey("2"),
      origin: "https://api.arcopolis.ai",
      savedAt: "2026-09-22T00:00:00.000Z",
    },
    source: "import",
    ...overrides,
  };
}

describe("store paths", () => {
  it("resolves ARCOPOLIS_CONFIG_DIR, XDG, APPDATA, then ~/.config", () => {
    const base = { cwd: "/work/repo", homedir: "/home/u", platform: "linux" as const };
    expect(resolveStorePaths({ ...base, env: { ARCOPOLIS_CONFIG_DIR: "/tmp/x" } }).dir).toBe("/tmp/x");
    expect(resolveStorePaths({ ...base, env: { XDG_CONFIG_HOME: "/xdg" } }).dir).toBe("/xdg/arcopolis");
    expect(resolveStorePaths({ ...base, env: {} }).dir).toBe("/home/u/.config/arcopolis");
    const project = resolveStorePaths({ ...base, env: { ARCOPOLIS_CONFIG_DIR: ".arcopolis" }, projectRoot: "/work/repo" });
    expect(project.dir).toBe("/work/repo/.arcopolis");
    expect(project.kind).toBe("project");
    expect(resolveStorePaths({ ...base, env: {}, store: "project", projectRoot: "/work/repo" }).dir).toBe("/work/repo/.arcopolis");
    const windows = resolveStorePaths({ ...base, platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData" } });
    expect(windows.posixModes).toBe(false);
    expect(displayPath("/home/u/.config/arcopolis", "/home/u")).toBe("~/.config/arcopolis");
  });
});

describe("credential store files", () => {
  it.runIf(posix)("creates the directory 0700 and writes files 0600 atomically", async () => {
    const store = new CredentialStore(resolveStorePaths({ env: { ARCOPOLIS_CONFIG_DIR: path.join(dir, "store") }, cwd: dir }));
    await store.updateCredentials((file) => {
      file.profiles.default = profile();
    });
    expect(modeOf((await stat(store.paths.dir)).mode)).toBe(0o700);
    expect(modeOf((await stat(store.paths.credentialsFile)).mode)).toBe(0o600);
    const entries = await readdir(store.paths.dir);
    expect(entries.filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);
    const reread = await store.readCredentials();
    expect(reread.profiles.default?.readKey?.key).toBe(fakeKey("1"));
  });

  it("an absent store reads as empty with default config", async () => {
    const store = new CredentialStore(resolveStorePaths({ env: { ARCOPOLIS_CONFIG_DIR: path.join(dir, "none") }, cwd: dir }));
    expect(await store.readCredentials()).toEqual(emptyCredentials());
    expect(await store.readConfig()).toEqual(defaultConfig());
  });

  it("creates installId once", async () => {
    const store = new CredentialStore(resolveStorePaths({ env: { ARCOPOLIS_CONFIG_DIR: path.join(dir, "s") }, cwd: dir }));
    const first = await store.ensureInstallId();
    expect(first).toMatch(/^[0-9a-f]{6}$/);
    expect(await store.ensureInstallId()).toBe(first);
    if (posix) expect(modeOf((await stat(store.paths.configFile)).mode)).toBe(0o600);
  });

  it.runIf(posix)("refuses a group-readable secret file with exit 3", async () => {
    const storeDir = path.join(dir, "loose");
    await mkdir(storeDir, { recursive: true });
    const file = path.join(storeDir, "credentials.json");
    await writeFile(file, JSON.stringify(emptyCredentials()));
    await chmod(file, 0o640);
    const store = new CredentialStore(resolveStorePaths({ env: { ARCOPOLIS_CONFIG_DIR: storeDir }, cwd: dir }));
    const error = await store.readCredentials().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("INSECURE_CREDENTIAL_FILE");
    expect((error as CliError).exitCode).toBe(3);
    expect((error as CliError).hint).toContain("doctor --fix-permissions");
    const findings = await store.inspectPermissions();
    expect(findings.find((finding) => finding.path === file)?.ok).toBe(false);
    expect(await store.fixPermissions()).toContain(file);
    expect((await store.readCredentials()).schemaVersion).toBe(1);
  });

  it("rejects an invalid credentials file shape", async () => {
    const storeDir = path.join(dir, "bad");
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    await atomicWriteFile(path.join(storeDir, "credentials.json"), '{"schemaVersion":2}');
    const store = new CredentialStore(resolveStorePaths({ env: { ARCOPOLIS_CONFIG_DIR: storeDir }, cwd: dir }));
    await expect(store.readCredentials()).rejects.toMatchObject({ code: "CREDENTIALS_FILE_INVALID", exitCode: 3 });
  });

  it("atomicWriteFile replaces content and leaves no temp files", async () => {
    const file = path.join(dir, "state.json");
    await atomicWriteFile(file, "one\n");
    await atomicWriteFile(file, "two\n");
    expect(await readFile(file, "utf8")).toBe("two\n");
    expect((await readdir(dir)).sort()).toEqual(["state.json"]);
    if (posix) expect(modeOf((await stat(file)).mode)).toBe(0o600);
  });

  it("lock contention gives STATE_LOCKED (exit 13) and the lock is released after", async () => {
    const file = path.join(dir, "locked.json");
    let release: () => void = () => undefined;
    const held = withFileLock(file, () => new Promise<void>((resolve) => (release = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const error = await withFileLock(file, async () => "never", { waitMs: 50, pollMs: 10 }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "STATE_LOCKED", exitCode: 13 });
    release();
    await held;
    await expect(withFileLock(file, async () => "ok")).resolves.toBe("ok");
    expect(await readdir(dir)).toEqual([]);
  });

  it("demo memory store never touches disk and refuses writes", async () => {
    const memoryDir = path.join(dir, "memory");
    const store = new CredentialStore(resolveStorePaths({ env: { ARCOPOLIS_CONFIG_DIR: memoryDir }, cwd: dir }), {
      memory: { credentials: { schemaVersion: 1, profiles: { default: profile() } }, config: defaultConfig() },
    });
    expect((await store.readCredentials()).profiles.default).toBeDefined();
    await expect(store.updateCredentials(() => undefined)).rejects.toMatchObject({ code: "DEMO_WRITE_BLOCKED" });
    await expect(stat(memoryDir)).rejects.toThrow();
  });
});

describe("config parsing", () => {
  it("an unknown writePolicy fails closed to deny with a warning", () => {
    const warnings: string[] = [];
    const config = parseConfig({ writePolicy: "tty_only", installId: "abc123", defaultProfile: "work" }, (code) => warnings.push(code));
    expect(config.writePolicy).toBe("deny");
    expect(config.installId).toBe("abc123");
    expect(config.defaultProfile).toBe("work");
    expect(warnings).toEqual(["CONFIG_INVALID_WRITE_POLICY"]);
  });
});

describe("resolution order", () => {
  const credentials: CredentialsFile = { schemaVersion: 1, profiles: { default: profile(), work: profile({ readKey: null }) } };
  const config = defaultConfig();

  it("read key: ARCOPOLIS_API_KEY, then legacy AGNTS_API_KEY with a warning, then the profile", () => {
    const warnings: string[] = [];
    const warn = (code: string): void => {
      warnings.push(code);
    };
    const envKey = fakeKey("3");
    expect(resolveCredentials({ env: { ARCOPOLIS_API_KEY: envKey }, flags: {}, credentials, config, project: null }).read).toMatchObject({
      value: envKey,
      source: "env",
      variable: "ARCOPOLIS_API_KEY",
    });
    const legacy = resolveCredentials({ env: { AGNTS_API_KEY: envKey }, flags: {}, credentials, config, project: null, warn });
    expect(legacy.read).toMatchObject({ source: "legacy_env", variable: "AGNTS_API_KEY" });
    expect(warnings).toEqual(["DEPRECATED_ENV"]);
    const stored = resolveCredentials({ env: {}, flags: {}, credentials, config, project: null });
    expect(stored.read).toMatchObject({ source: "store", origin: "https://api.arcopolis.ai", profile: "default" });
  });

  it("visitor key: env visitor key, then the read key only with an env agent id and no stored visitor key", () => {
    const readKey = fakeKey("4");
    const visitorKey = fakeKey("5");
    expect(
      resolveCredentials({ env: { ARCOPOLIS_VISITOR_API_KEY: visitorKey }, flags: {}, credentials, config, project: null }).visitor?.value,
    ).toBe(visitorKey);
    const noStoredVisitor: CredentialsFile = { schemaVersion: 1, profiles: {} };
    expect(
      resolveCredentials({
        env: { ARCOPOLIS_API_KEY: readKey, ARCOPOLIS_VISITOR_AGENT_ID: "visitor_env" },
        flags: {},
        credentials: noStoredVisitor,
        config,
        project: null,
      }).visitor,
    ).toMatchObject({ value: readKey, variable: "ARCOPOLIS_API_KEY" });
    expect(
      resolveCredentials({ env: { ARCOPOLIS_API_KEY: readKey }, flags: {}, credentials: noStoredVisitor, config, project: null }).visitor,
    ).toBeNull();
    expect(
      resolveCredentials({
        env: { ARCOPOLIS_API_KEY: readKey, ARCOPOLIS_VISITOR_AGENT_ID: "visitor_env" },
        flags: {},
        credentials,
        config,
        project: null,
      }).visitor,
    ).toMatchObject({ source: "store", value: fakeKey("2") });
  });

  it("agent id: --agent, env, project, profile", () => {
    const base = { credentials, config };
    expect(resolveCredentials({ ...base, env: { ARCOPOLIS_VISITOR_AGENT_ID: "e" }, flags: { agent: "f" }, project: { visitor: { agentId: "p" } } }).agentId).toEqual({
      value: "f",
      source: "flag",
    });
    expect(resolveCredentials({ ...base, env: { ARCOPOLIS_VISITOR_AGENT_ID: "e" }, flags: {}, project: { visitor: { agentId: "p" } } }).agentId?.source).toBe("env");
    expect(resolveCredentials({ ...base, env: {}, flags: {}, project: { visitor: { agentId: "p" } } }).agentId?.source).toBe("project");
    expect(resolveCredentials({ ...base, env: {}, flags: {}, project: null }).agentId).toEqual({ value: "visitor_store", source: "profile" });
  });

  it("profile: --profile, ARCOPOLIS_PROFILE, project, config, default", () => {
    const pick = (input: { flag?: string; env?: string; project?: string; config?: string }): string =>
      resolveCredentials({
        env: input.env ? { ARCOPOLIS_PROFILE: input.env } : {},
        flags: { profile: input.flag },
        credentials,
        config: { ...config, defaultProfile: input.config },
        project: input.project ? { profile: input.project } : null,
      }).profile.source;
    expect(pick({ flag: "a", env: "b", project: "c", config: "d" })).toBe("flag");
    expect(pick({ env: "b", project: "c", config: "d" })).toBe("env");
    expect(pick({ project: "c", config: "d" })).toBe("project");
    expect(pick({ config: "d" })).toBe("config");
    expect(pick({})).toBe("default");
    const work = resolveCredentials({ env: {}, flags: { profile: "work" }, credentials, config, project: null });
    expect(work.profile).toEqual({ name: "work", source: "flag", exists: true });
    expect(work.read).toBeNull();
    expect(() => resolveCredentials({ env: {}, flags: { profile: "Bad Name" }, credentials, config, project: null })).toThrow(CliError);
  });
});

describe("store inside a git repository", () => {
  it("a project store adds the .gitignore block before writing", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const store = new CredentialStore(resolveStorePaths({ env: {}, cwd: dir, store: "project", projectRoot: dir }));
    await store.updateCredentials((file) => {
      file.profiles.default = profile();
    });
    expect(await readFile(path.join(dir, ".gitignore"), "utf8")).toContain(".arcopolis/");
    const ignored = execFileSync("git", ["check-ignore", ".arcopolis/credentials.json"], { cwd: dir, encoding: "utf8" });
    expect(ignored.trim()).toBe(".arcopolis/credentials.json");
  });

  it("refuses an ARCOPOLIS_CONFIG_DIR store that git does not ignore, before writing anything", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const store = new CredentialStore(resolveStorePaths({ env: { ARCOPOLIS_CONFIG_DIR: path.join(dir, "secrets") }, cwd: dir }));
    await expect(store.ensureInstallId()).rejects.toMatchObject({ code: "STORE_NOT_IGNORED", exitCode: 2 });
    expect(existsSync(path.join(dir, "secrets"))).toBe(false);
  });

  it("refuses a project store reached through a committed symlink into a tracked directory", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await mkdir(path.join(dir, "exposed"));
    await writeFile(path.join(dir, "exposed", "README.md"), "tracked\n");
    await symlink("exposed", path.join(dir, ".arcopolis"));
    const paths = resolveStorePaths({ env: { ARCOPOLIS_CONFIG_DIR: ".arcopolis" }, cwd: dir, projectRoot: dir });
    expect(paths.kind).toBe("project");
    expect(await inspectStoreLocation(paths)).toMatchObject({ gitRoot: dir, symlink: path.join(dir, ".arcopolis") });
    const store = new CredentialStore(paths);
    await expect(
      store.updateCredentials((file) => {
        file.profiles.default = profile();
      }),
    ).rejects.toMatchObject({ code: "STORE_PATH_SYMLINK" });
    expect(existsSync(path.join(dir, "exposed", "credentials.json"))).toBe(false);

    const doctor = await run(["doctor", "--json"], { env: { ARCOPOLIS_CONFIG_DIR: ".arcopolis" }, cwd: dir });
    const checks = (doctor.json?.data as { checks: Array<{ id: string; status: string; code?: string; message: string }> }).checks;
    expect(checks.find((entry) => entry.id === "store_location")).toMatchObject({ status: "fail", code: "STORE_PATH_SYMLINK" });
    expect(JSON.stringify(checks)).not.toContain("(ignored by git)");
  });

  it("an ignored ARCOPOLIS_CONFIG_DIR store is accepted, and a user store in a repository still only warns", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await writeFile(path.join(dir, ".gitignore"), "secrets/\n");
    const ignored = new CredentialStore(resolveStorePaths({ env: { ARCOPOLIS_CONFIG_DIR: path.join(dir, "secrets") }, cwd: dir }));
    await ignored.ensureInstallId();
    expect(existsSync(path.join(dir, "secrets", "config.json"))).toBe(true);

    const warnings: string[] = [];
    const user = new CredentialStore(resolveStorePaths({ env: { XDG_CONFIG_HOME: path.join(dir, "xdg") }, cwd: dir }), {
      warn: (code) => warnings.push(code),
    });
    expect(user.paths.kind).toBe("user");
    await user.ensureInstallId();
    expect(warnings).toEqual(["STORE_IN_GIT_REPO"]);
  });

  it("a .gitignore that is a symbolic link is never read or replaced", async () => {
    const outside = path.join(dir, "outside-secret.txt");
    await writeFile(outside, "aws_secret_access_key = SUPERSECRET123\n");
    const project = path.join(dir, "repo");
    await mkdir(project);
    await symlink(outside, path.join(project, ".gitignore"));
    await expect(ensureGitignore(project)).rejects.toMatchObject({ code: "GITIGNORE_SYMLINK", exitCode: 2 });
    expect((await import("node:fs/promises").then((fs) => fs.lstat(path.join(project, ".gitignore")))).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("aws_secret_access_key = SUPERSECRET123\n");
  });
});

describe("writePolicy cannot be relocated", () => {
  it("the most restrictive of the active store and the user config wins, and names its source", async () => {
    const home = path.join(dir, "home");
    const userDir = path.join(home, ".config", "arcopolis");
    await mkdir(userDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(userDir, "config.json"), JSON.stringify({ schemaVersion: 1, writePolicy: "deny" }), { mode: 0o600 });
    const elsewhere = new CredentialStore(resolveStorePaths({ env: { ARCOPOLIS_CONFIG_DIR: path.join(dir, "elsewhere") }, cwd: dir, homedir: home }));
    const effective = await effectiveWritePolicy({ store: elsewhere, env: {}, homedir: home });
    expect(effective).toMatchObject({ policy: "deny", source: path.join(userDir, "config.json") });

    await mkdir(path.join(dir, "elsewhere"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, "elsewhere", "config.json"), JSON.stringify({ schemaVersion: 1, writePolicy: "tty-only" }), { mode: 0o600 });
    await writeFile(path.join(userDir, "config.json"), JSON.stringify({ schemaVersion: 1, writePolicy: "flag" }), { mode: 0o600 });
    expect(await effectiveWritePolicy({ store: elsewhere, env: {}, homedir: home })).toMatchObject({
      policy: "tty-only",
      source: path.join(dir, "elsewhere", "config.json"),
    });
    const home2 = path.join(dir, "home2");
    expect(await effectiveWritePolicy({ store: elsewhere, env: {}, homedir: home2 })).toMatchObject({ policy: "tty-only" });
  });
});
