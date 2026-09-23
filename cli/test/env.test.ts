import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeFetch, fakeKey, json, run, tempDir } from "./helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
let store: string;
let project: string;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir("arcopolis-env-"));
  store = path.join(dir, "store");
  project = path.join(dir, "project");
  await mkdir(project, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: project, stdio: "ignore" });
  await mkdir(store, { recursive: true, mode: 0o700 });
  const file = path.join(store, "credentials.json");
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      profiles: {
        default: {
          source: "import",
          readKey: { key: fakeKey("a"), origin: "https://api.arcopolis.ai", savedAt: "2026-09-01T00:00:00.000Z" },
          visitor: { agentId: "visitor_ada", key: fakeKey("d"), origin: "https://api.arcopolis.ai", savedAt: "2026-09-01T00:00:00.000Z" },
        },
      },
    }),
  );
  await chmod(file, 0o600);
});
afterEach(async () => {
  await cleanup();
});

const env = (): Record<string, string> => ({ ARCOPOLIS_CONFIG_DIR: store });

describe("env write", () => {
  it("never prompts without a TTY: a file git does not ignore exits 10 and is not written", async () => {
    const fake = fakeFetch(() => json(500, {}));
    const result = await run(["env", "write", ".env.arcopolis"], { env: env(), cwd: project, fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(10);
    expect(result.json).toMatchObject({ error: { code: "CONFIRMATION_REQUIRED", humanDecision: true } });
    expect(result.stderr).not.toContain("[y/N]");
    expect(fake.calls).toHaveLength(0);
    await expect(stat(path.join(project, ".env.arcopolis"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("--yes adds the file to .gitignore, writes it at 0600, and prints names and prefixes only", async () => {
    const result = await run(["env", "write", ".env.arcopolis", "--yes"], { env: env(), cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      data: {
        path: ".env.arcopolis",
        action: "created",
        fileMode: "0600",
        inRepo: true,
        gitignore: { action: "created", added: [".arcopolis-*", ".arcopolis/", ".env.arcopolis"] },
        variables: [
          { name: "ARCOPOLIS_API_BASE", preview: "https://api.arcopolis.ai/v1" },
          { name: "ARCOPOLIS_API_KEY", preview: "agnts_aaaa…" },
          { name: "ARCOPOLIS_VISITOR_API_KEY", preview: "agnts_dddd…" },
          { name: "ARCOPOLIS_VISITOR_AGENT_ID", preview: "visitor_ada" },
        ],
      },
      effects: {
        requests: 0,
        writes: ["project_files", "env_file"],
        secretsWritten: ["env_file:ARCOPOLIS_API_KEY", "env_file:ARCOPOLIS_VISITOR_API_KEY"],
      },
    });
    expect(result.stdout).not.toContain(fakeKey("a"));
    expect(result.stdout).not.toContain(fakeKey("d"));
    const file = path.join(project, ".env.arcopolis");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const content = await readFile(file, "utf8");
    expect(content).toContain(`ARCOPOLIS_API_KEY=${fakeKey("a")}`);
    expect(content.startsWith("# arcopolis:start\n")).toBe(true);
    expect(await readFile(path.join(project, ".gitignore"), "utf8")).toContain(".env.arcopolis");
    const again = await run(["env", "write", ".env.arcopolis"], { env: env(), cwd: project });
    expect(again.json).toMatchObject({ data: { action: "unchanged", gitignore: null } });
  });

  it("keeps the rest of an existing ignored env file", async () => {
    await writeFile(path.join(project, ".gitignore"), ".env.local\n");
    await writeFile(path.join(project, ".env.local"), "OTHER=1\n", { mode: 0o644 });
    const result = await run(["env", "write", ".env.local"], { env: env(), cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ data: { action: "updated", gitignore: null } });
    const content = await readFile(path.join(project, ".env.local"), "utf8");
    expect(content.startsWith("OTHER=1\n# arcopolis:start\n")).toBe(true);
    expect((await stat(path.join(project, ".env.local"))).mode & 0o777).toBe(0o600);
  });

  it("refuses a file git tracks (exit 2)", async () => {
    await writeFile(path.join(project, ".env"), "X=1\n");
    execFileSync("git", ["add", ".env"], { cwd: project, stdio: "ignore" });
    const result = await run(["env", "write", ".env", "--yes"], { env: env(), cwd: project });
    expect(result.exitCode).toBe(2);
    expect(result.json).toMatchObject({ error: { code: "ENV_FILE_TRACKED" } });
    expect(await readFile(path.join(project, ".env"), "utf8")).toBe("X=1\n");
  });

  it("with no credentials exits 3 before touching anything", async () => {
    const result = await run(["env", "write", ".env.arcopolis", "--yes"], { env: { ARCOPOLIS_CONFIG_DIR: path.join(dir, "empty") }, cwd: project });
    expect(result.exitCode).toBe(3);
    expect(result.json).toMatchObject({ error: { code: "NO_CREDENTIALS" }, next: [{ command: "arcopolis setup --json" }] });
    await expect(stat(path.join(project, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never hands a stored key to a custom base (exit 3)", async () => {
    const result = await run(["env", "write", ".env.arcopolis", "--yes"], {
      env: { ...env(), ARCOPOLIS_API_BASE: "https://staging.example.com/v1", ARCOPOLIS_ALLOW_CUSTOM_BASE: "1" },
      cwd: project,
    });
    expect(result.exitCode).toBe(3);
    expect(result.json).toMatchObject({ error: { code: "STORED_KEY_ORIGIN_MISMATCH" } });
  });

  it("demo mode plans without writing", async () => {
    const result = await run(["env", "write", ".env.arcopolis", "--demo"], { env: env(), cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ meta: { demo: true }, data: { action: "planned", demo: true } });
    await expect(stat(path.join(project, ".env.arcopolis"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("env status", () => {
  it("lists managed env files and variable names, never values", async () => {
    await run(["env", "write", ".env.arcopolis", "--yes"], { env: env(), cwd: project });
    const result = await run(["env", "status"], { env: { ...env(), ARCOPOLIS_API_KEY: fakeKey("b") }, cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      data: {
        files: [
          {
            path: ".env.arcopolis",
            exists: true,
            mode: "0600",
            tracked: false,
            ignored: true,
            ok: true,
            managedVariables: ["ARCOPOLIS_API_BASE", "ARCOPOLIS_API_KEY", "ARCOPOLIS_VISITOR_API_KEY", "ARCOPOLIS_VISITOR_AGENT_ID"],
          },
        ],
        environment: ["ARCOPOLIS_API_KEY", "ARCOPOLIS_CONFIG_DIR"],
      },
      effects: { requests: 0, writes: [] },
    });
    expect(result.stdout).not.toContain(fakeKey("a"));
    expect(result.stdout).not.toContain(fakeKey("b"));
  });

  it("flags an explicit path that is missing or not ignored", async () => {
    const result = await run(["env", "status", ".env.other"], { env: env(), cwd: project });
    expect(result.json).toMatchObject({ data: { files: [{ path: ".env.other", exists: false, ok: false, problems: ["missing", "not ignored by git"] }] } });
  });
});
