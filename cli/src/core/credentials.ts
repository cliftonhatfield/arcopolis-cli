/**
 * Credential store and resolution (plan §5).
 *
 * User store: `$ARCOPOLIS_CONFIG_DIR`, else `$XDG_CONFIG_HOME/arcopolis`,
 * else `~/.config/arcopolis`, else `%APPDATA%\arcopolis` on Windows. The
 * directory is 0700; every write is atomic (temp file `wx` 0600, fsync,
 * rename, chmod) under an `O_EXCL` `<file>.lock`; a secret file that is
 * group- or world-readable is refused (exit 3).
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.js";
import { atomicWriteFile, errno, withFileLock } from "./files.js";
import { ensureGitignore, gitIsIgnored } from "./gitignore.js";
import { findGitRootSync, type ProjectConfig } from "./project.js";

export { atomicWriteFile, withFileLock, type LockOptions } from "./files.js";

export const CREDENTIALS_FILE = "credentials.json";
export const CONFIG_FILE = "config.json";
export const PENDING_GRANT_FILE = "pending-grant.json";
export const CACHE_DIR = "cache";

/** A Public API key as issued: `agnts_` + 64 lowercase hex. */
export const API_KEY_PATTERN = /^agnts_[0-9a-f]{64}$/;
export const PROFILE_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;
export const AGENT_ID_PATTERN = /^[A-Za-z0-9_:.-]{1,240}$/;
export const INSTALL_ID_PATTERN = /^[0-9a-f]{6}$/;

export type Env = Readonly<Record<string, string | undefined>>;
export type WarnFn = (code: string, message: string) => void;

// ---------------------------------------------------------------------------
// File schemas
// ---------------------------------------------------------------------------

export interface ReadKeyRecord {
  id?: string | null;
  key: string;
  name?: string | null;
  tier?: number | null;
  scopes?: string[] | null;
  rateLimitPerMinute?: number | null;
  /** Origin the key was saved for; the key is sent only there. */
  origin: string;
  savedAt: string;
  lastVerifiedAt?: string | null;
}

export interface VisitorRecord {
  agentId: string;
  handle?: string | null;
  worldId?: string | null;
  keyId?: string | null;
  key: string;
  driveDailyBudget?: number | null;
  keyCreatedAt?: string | null;
  origin: string;
  savedAt: string;
  lastVerifiedAt?: string | null;
}

export interface ProfileRecord {
  apiBase?: string | null;
  developerBase?: string | null;
  account?: { uid?: string | null; email?: string | null } | null;
  app?: { id?: string | null; name?: string | null } | null;
  readKey?: ReadKeyRecord | null;
  visitor?: VisitorRecord | null;
  terms?: {
    developer?: string | null;
    visitorCorpus?: string | null;
    acceptedVia: "portal_approval" | "import";
  } | null;
  source: "grant" | "import";
}

export interface CredentialsFile {
  schemaVersion: 1;
  profiles: Record<string, ProfileRecord>;
}

export type WritePolicy = "flag" | "tty-only" | "deny";

export interface ConfigFile {
  schemaVersion: 1;
  defaultProfile?: string;
  writePolicy: WritePolicy;
  /** 6 hex, created once by {@link CredentialStore.ensureInstallId}; absent until then. */
  installId?: string;
  output: "auto" | "json" | "human";
}

export function emptyCredentials(): CredentialsFile {
  return { schemaVersion: 1, profiles: {} };
}

export function defaultConfig(): ConfigFile {
  return { schemaVersion: 1, writePolicy: "flag", output: "auto" };
}

/** True for a well-formed `agnts_` + 64 hex key. */
export function isValidApiKey(value: string): boolean {
  return API_KEY_PATTERN.test(value);
}

/** Random 6-hex install id. */
export function generateInstallId(): string {
  return randomBytes(3).toString("hex");
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export type StoreKind = "user" | "project" | "env";

export interface StorePaths {
  dir: string;
  kind: StoreKind;
  credentialsFile: string;
  configFile: string;
  pendingGrantFile: string;
  cacheDir: string;
  /** Windows does not enforce POSIX modes. */
  posixModes: boolean;
}

export interface StorePathInput {
  env: Env;
  cwd: string;
  /** Where `.arcopolis/` lives for `--store project` (the git root, else cwd). */
  projectRoot?: string | null;
  store?: "user" | "project";
  platform?: NodeJS.Platform;
  homedir?: string;
}

/**
 * Resolves the store directory. `--store project` wins, then
 * `ARCOPOLIS_CONFIG_DIR` (a relative value such as `.arcopolis` is resolved
 * against the project root), then XDG, then the platform default.
 */
export function resolveStorePaths(input: StorePathInput): StorePaths {
  const platform = input.platform ?? process.platform;
  const home = input.homedir ?? os.homedir();
  const projectRoot = input.projectRoot ?? input.cwd;
  let dir: string;
  let kind: StoreKind;
  const configured = input.env.ARCOPOLIS_CONFIG_DIR?.trim();
  if (input.store === "project") {
    dir = path.join(projectRoot, ".arcopolis");
    kind = "project";
  } else if (configured) {
    dir = path.isAbsolute(configured) ? configured : path.resolve(projectRoot, configured);
    kind = path.resolve(dir) === path.join(projectRoot, ".arcopolis") ? "project" : "env";
  } else if (input.env.XDG_CONFIG_HOME?.trim()) {
    dir = path.join(input.env.XDG_CONFIG_HOME.trim(), "arcopolis");
    kind = "user";
  } else if (platform === "win32" && input.env.APPDATA?.trim()) {
    dir = path.join(input.env.APPDATA.trim(), "arcopolis");
    kind = "user";
  } else {
    dir = path.join(home, ".config", "arcopolis");
    kind = "user";
  }
  return {
    dir,
    kind,
    credentialsFile: path.join(dir, CREDENTIALS_FILE),
    configFile: path.join(dir, CONFIG_FILE),
    pendingGrantFile: path.join(dir, PENDING_GRANT_FILE),
    cacheDir: path.join(dir, CACHE_DIR),
    posixModes: platform !== "win32",
  };
}

/**
 * The platform-default user store directories, independent of
 * `ARCOPOLIS_CONFIG_DIR`: `$XDG_CONFIG_HOME/arcopolis` (when set),
 * `%APPDATA%\arcopolis` and `<home>\AppData\Roaming\arcopolis` (Windows), and
 * `<home>/.config/arcopolis`, where
 * home comes from the account database rather than `$HOME` when possible.
 * Their `config.json` files set a floor under `writePolicy` that relocating
 * the store cannot lower.
 */
export function userConfigDirs(input: { env: Env; platform?: NodeJS.Platform; homedir?: string }): string[] {
  const platform = input.platform ?? process.platform;
  let home = input.homedir;
  if (!home) {
    try {
      home = os.userInfo().homedir;
    } catch {
      home = os.homedir();
    }
  }
  const dirs: string[] = [];
  const xdg = input.env.XDG_CONFIG_HOME?.trim();
  if (xdg) dirs.push(path.join(xdg, "arcopolis"));
  const appData = input.env.APPDATA?.trim();
  if (platform === "win32" && appData) dirs.push(path.join(appData, "arcopolis"));
  // The standard roaming AppData under the account home, in case APPDATA was pointed elsewhere.
  if (platform === "win32" && home) dirs.push(path.join(home, "AppData", "Roaming", "arcopolis"));
  if (home) dirs.push(path.join(home, ".config", "arcopolis"));
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

/** Restrictiveness order of write policies (higher wins). */
const POLICY_RANK: Record<WritePolicy, number> = { flag: 0, "tty-only": 1, deny: 2 };

/** The write policy in force and the `config.json` it came from. */
export interface EffectiveWritePolicy {
  policy: WritePolicy;
  /** The file that set it, or null for the built-in default (`flag`). */
  source: string | null;
  /** Every config file consulted and what it said (`unreadable` fails closed to `deny`). */
  consulted: Array<{ file: string; policy: WritePolicy | "absent" | "unreadable" }>;
}

/**
 * The most restrictive `writePolicy` of the active store's `config.json` and
 * every platform-default user `config.json` ({@link userConfigDirs}), so a
 * human's `deny` or `tty-only` holds even when an agent points
 * `ARCOPOLIS_CONFIG_DIR` somewhere else. An unreadable file counts as
 * `deny`.
 */
export async function effectiveWritePolicy(input: {
  store: CredentialStore;
  env: Env;
  platform?: NodeJS.Platform;
  homedir?: string;
  warn?: WarnFn;
}): Promise<EffectiveWritePolicy> {
  const consulted: EffectiveWritePolicy["consulted"] = [];
  let best: { policy: WritePolicy; source: string | null } = { policy: "flag", source: null };
  const consider = (file: string, policy: WritePolicy | "absent" | "unreadable"): void => {
    consulted.push({ file, policy });
    const effective: WritePolicy | null = policy === "absent" ? null : policy === "unreadable" ? "deny" : policy;
    if (effective && POLICY_RANK[effective] > POLICY_RANK[best.policy]) best = { policy: effective, source: file };
  };
  const own = input.store.paths.configFile;
  try {
    const config = await input.store.readConfig();
    consider(own, input.store.isMemory ? config.writePolicy : (await fileExists(own)) ? config.writePolicy : "absent");
  } catch {
    input.warn?.("CONFIG_UNREADABLE", `${displayPath(own)} could not be read; writes are treated as disabled.`);
    consider(own, "unreadable");
  }
  if (!input.store.isMemory) {
    for (const dir of userConfigDirs(input)) {
      const file = path.join(dir, CONFIG_FILE);
      if (path.resolve(file) === path.resolve(own)) continue;
      try {
        const read = await readStoreFile(file, { secret: false, posixModes: input.store.paths.posixModes });
        if (!read) {
          consider(file, "absent");
          continue;
        }
        let value: unknown = null;
        try {
          value = JSON.parse(read.text);
        } catch {
          input.warn?.("CONFIG_INVALID", `${displayPath(file)} is not valid JSON; treating writePolicy as "deny".`);
          consider(file, "unreadable");
          continue;
        }
        consider(file, parseConfig(value, input.warn).writePolicy);
      } catch {
        input.warn?.("CONFIG_UNREADABLE", `${displayPath(file)} could not be read; writes are treated as disabled.`);
        consider(file, "unreadable");
      }
    }
  }
  return { ...best, consulted };
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

/** `~/.config/arcopolis` style display path (home abbreviated). */
export function displayPath(target: string, home: string = os.homedir()): string {
  if (home && (target === home || target.startsWith(`${home}${path.sep}`))) {
    return `~${target.slice(home.length)}`;
  }
  return target;
}

// ---------------------------------------------------------------------------
// Low-level file helpers
// ---------------------------------------------------------------------------

/** Result of reading a file: its text and mode, or null when it does not exist. */
export interface FileRead {
  text: string;
  mode: number;
}

/**
 * Reads a file without following a symlink. With `secret`, refuses a file
 * whose mode grants any group or world permission (`INSECURE_CREDENTIAL_FILE`,
 * exit 3) when POSIX modes apply.
 */
export async function readStoreFile(file: string, options: { secret: boolean; posixModes: boolean }): Promise<FileRead | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    const mode = info.mode & 0o777;
    if (options.secret && options.posixModes && (mode & 0o077) !== 0) {
      throw new CliError(
        "INSECURE_CREDENTIAL_FILE",
        `${path.basename(file)} is readable by other users (mode ${mode.toString(8).padStart(4, "0")}); refusing to read it.`,
        { hint: "Run arcopolis doctor --fix-permissions (or chmod 600 the file).", details: { file } },
      );
    }
    return { text: await handle.readFile("utf8"), mode };
  } catch (error) {
    if (error instanceof CliError) throw error;
    const code = errno(error);
    if (code === "ENOENT") return null;
    if (code === "ELOOP") {
      throw new CliError("INSECURE_CREDENTIAL_FILE", `${path.basename(file)} is a symbolic link; refusing to read it.`, {
        details: { file },
      });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseJsonFile(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError("CREDENTIALS_FILE_INVALID", `${path.basename(file)} is not valid JSON.`, {
      hint: "Inspect the file; do not delete it blindly. arcopolis doctor reports what it expected.",
      details: { file },
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Validates the credentials file shape (schemaVersion 1, profiles object). */
export function parseCredentials(value: unknown, file = CREDENTIALS_FILE): CredentialsFile {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.profiles)) {
    throw new CliError("CREDENTIALS_FILE_INVALID", `${path.basename(file)} does not match schemaVersion 1.`, {
      details: { file },
    });
  }
  return value as unknown as CredentialsFile;
}

/** Validates `config.json`, filling defaults. An unknown writePolicy fails closed to `deny`. */
export function parseConfig(value: unknown, warn?: WarnFn): ConfigFile {
  const config = defaultConfig();
  if (!isRecord(value)) return config;
  if (typeof value.defaultProfile === "string" && PROFILE_NAME_PATTERN.test(value.defaultProfile)) {
    config.defaultProfile = value.defaultProfile;
  }
  if (value.writePolicy !== undefined) {
    if (value.writePolicy === "flag" || value.writePolicy === "tty-only" || value.writePolicy === "deny") {
      config.writePolicy = value.writePolicy;
    } else {
      config.writePolicy = "deny";
      warn?.("CONFIG_INVALID_WRITE_POLICY", "config.json has an unknown writePolicy; treating it as \"deny\".");
    }
  }
  if (typeof value.installId === "string" && INSTALL_ID_PATTERN.test(value.installId)) config.installId = value.installId;
  if (value.output === "json" || value.output === "human" || value.output === "auto") config.output = value.output;
  return config;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** In-memory backing used by `--demo`: nothing is read from or written to disk. */
export interface MemoryBacking {
  credentials: CredentialsFile;
  config: ConfigFile;
}

export interface CredentialStoreOptions {
  memory?: MemoryBacking;
  warn?: WarnFn;
}

/** One permission finding for `doctor`. */
export interface PermissionFinding {
  path: string;
  expected: string;
  actual: string | null;
  ok: boolean;
}

const SECRET_FILES = new Set([CREDENTIALS_FILE, PENDING_GRANT_FILE]);

/** Where the store sits relative to git (for `ensureDir` and `doctor`). */
export interface StoreLocation {
  /** The enclosing git work tree, or null outside one. */
  gitRoot: string | null;
  /** The first path under the git root (store directory or file included) that is a symbolic link. */
  symlink: string | null;
  /** `git check-ignore` on `credentials.json`: true, false, or null when git could not tell. */
  ignored: boolean | null;
}

/** The first existing path component of `target` below `root` that is a symbolic link, or null. */
async function firstSymlinkBelow(root: string, target: string): Promise<string | null> {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return current;
    } catch (error) {
      if (errno(error) === "ENOENT") return null;
      throw error;
    }
  }
  return null;
}

/**
 * Inspects where a store sits: the enclosing git work tree, any symbolic
 * link on the way down from it (a committed `.arcopolis -> tracked/` link
 * would put keys in a tracked directory), and whether git ignores
 * `credentials.json`. A git error is `ignored: null` (unknown), never
 * "ignored".
 */
export async function inspectStoreLocation(paths: StorePaths): Promise<StoreLocation> {
  const gitRoot = findGitRootSync(path.dirname(paths.dir));
  if (!gitRoot) return { gitRoot: null, symlink: null, ignored: null };
  const symlink = await firstSymlinkBelow(gitRoot, paths.credentialsFile);
  if (symlink) return { gitRoot, symlink, ignored: null };
  const query = await gitIsIgnored(gitRoot, paths.credentialsFile);
  return { gitRoot, symlink: null, ignored: query.unknown || !query.repo ? null : query.result };
}

function storeSymlinkError(link: string): CliError {
  return new CliError("STORE_PATH_SYMLINK", `${displayPath(link)} is a symbolic link inside a git repository; keys are never written through one.`, {
    humanDecision: true,
    hint: "Remove the link, or set ARCOPOLIS_CONFIG_DIR to a real directory outside the repository (or to .arcopolis).",
    details: { path: link },
  });
}

function storeNotIgnoredError(dir: string, ignored: boolean | null): CliError {
  const why = ignored === null ? "git could not tell whether it is ignored" : "git does not ignore it";
  return new CliError("STORE_NOT_IGNORED", `The credential store ${displayPath(dir)} is inside a git repository and ${why}; nothing was written.`, {
    humanDecision: true,
    hint: "Add the directory to .gitignore, use ARCOPOLIS_CONFIG_DIR=.arcopolis (ignored automatically), or use a directory outside the repository.",
    details: { dir },
  });
}

/** File-backed (or, in demo mode, memory-backed) credential and config store. */
export class CredentialStore {
  private checkedRepo = false;

  constructor(
    readonly paths: StorePaths,
    private readonly options: CredentialStoreOptions = {},
  ) {}

  /** True in demo mode: reads come from memory and writes are refused. */
  get isMemory(): boolean {
    return this.options.memory !== undefined;
  }

  private assertWritable(): void {
    if (this.isMemory) {
      throw new CliError("DEMO_WRITE_BLOCKED", "Demo mode never writes files.", { humanDecision: false });
    }
  }

  /**
   * Creates the store directory at 0700 (and tightens it when it already
   * exists), after checking where it sits:
   * - A project or `ARCOPOLIS_CONFIG_DIR` store inside a git work tree is
   *   refused when any path on the way down from the git root is a symbolic
   *   link (`STORE_PATH_SYMLINK`), or when git does not ignore
   *   `credentials.json` or cannot tell (`STORE_NOT_IGNORED`). A project
   *   store (`<root>/.arcopolis/`) gets the `.gitignore` managed block first.
   * - The user store only warns (`STORE_IN_GIT_REPO`), since a home
   *   directory kept in git is a deliberate choice.
   */
  async ensureDir(): Promise<void> {
    this.assertWritable();
    if (!this.checkedRepo) {
      await this.assertSafeLocation();
      this.checkedRepo = true;
    }
    await mkdir(this.paths.dir, { recursive: true, mode: 0o700 });
    if (this.paths.posixModes) await chmod(this.paths.dir, 0o700);
  }

  private async assertSafeLocation(): Promise<void> {
    const strict = this.paths.kind !== "user";
    let location = await inspectStoreLocation(this.paths);
    if (location.symlink && strict) throw storeSymlinkError(location.symlink);
    if (this.paths.kind === "project") {
      await ensureGitignore(path.dirname(this.paths.dir));
      location = await inspectStoreLocation(this.paths);
    }
    if (!location.gitRoot || (!location.symlink && location.ignored === true)) return;
    if (strict) {
      if (location.symlink) throw storeSymlinkError(location.symlink);
      throw storeNotIgnoredError(this.paths.dir, location.ignored);
    }
    this.options.warn?.(
      "STORE_IN_GIT_REPO",
      `The credential store ${this.paths.dir} is inside a git repository and is not ignored; make sure it is never committed.`,
    );
  }

  /** Reads `credentials.json`; an absent file reads as an empty store. */
  async readCredentials(): Promise<CredentialsFile> {
    if (this.options.memory) return structuredClone(this.options.memory.credentials);
    const read = await readStoreFile(this.paths.credentialsFile, { secret: true, posixModes: this.paths.posixModes });
    if (!read) return emptyCredentials();
    return parseCredentials(parseJsonFile(read.text, this.paths.credentialsFile), this.paths.credentialsFile);
  }

  /** Locked read-modify-write of `credentials.json`. The mutator may edit in place or return a new file. */
  async updateCredentials(mutate: (file: CredentialsFile) => CredentialsFile | void): Promise<CredentialsFile> {
    this.assertWritable();
    await this.ensureDir();
    return withFileLock(this.paths.credentialsFile, async () => {
      const current = await this.readCredentials();
      const next = mutate(current) ?? current;
      parseCredentials(next);
      await atomicWriteFile(this.paths.credentialsFile, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  }

  /** Reads `config.json` with defaults; never writes. */
  async readConfig(): Promise<ConfigFile> {
    if (this.options.memory) return structuredClone(this.options.memory.config);
    const read = await readStoreFile(this.paths.configFile, { secret: false, posixModes: this.paths.posixModes });
    if (!read) return defaultConfig();
    let value: unknown = null;
    try {
      value = JSON.parse(read.text);
    } catch {
      this.options.warn?.("CONFIG_INVALID", "config.json is not valid JSON; using defaults (writePolicy \"deny\").");
      return { ...defaultConfig(), writePolicy: "deny" };
    }
    return parseConfig(value, this.options.warn);
  }

  /** Locked read-modify-write of `config.json` (0600). */
  async updateConfig(mutate: (file: ConfigFile) => ConfigFile | void): Promise<ConfigFile> {
    this.assertWritable();
    await this.ensureDir();
    return withFileLock(this.paths.configFile, async () => {
      const current = await this.readConfig();
      const next = mutate(current) ?? current;
      await atomicWriteFile(this.paths.configFile, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  }

  /** Returns the install id, creating it (once) when absent. Writes `config.json`. */
  async ensureInstallId(): Promise<string> {
    const current = await this.readConfig();
    if (current.installId) return current.installId;
    const next = await this.updateConfig((config) => {
      if (!config.installId) config.installId = generateInstallId();
    });
    return next.installId as string;
  }

  /** Absolute path of a store-relative file (`pending-grant.json`, `cache/<agentId>.json`). */
  resolve(relative: string): string {
    const target = path.resolve(this.paths.dir, relative);
    if (!target.startsWith(`${path.resolve(this.paths.dir)}${path.sep}`)) {
      throw new CliError("INTERNAL", "Store paths must stay inside the store directory.");
    }
    return target;
  }

  /** Reads a store-relative JSON file (null when absent). Secret files get the permission check. */
  async readJson<T>(relative: string): Promise<T | null> {
    if (this.options.memory) return null;
    const file = this.resolve(relative);
    const read = await readStoreFile(file, {
      secret: SECRET_FILES.has(path.basename(file)),
      posixModes: this.paths.posixModes,
    });
    if (!read) return null;
    return parseJsonFile(read.text, file) as T;
  }

  /** Atomically writes a store-relative JSON file at 0600 under its lock. */
  async writeJson(relative: string, value: unknown): Promise<void> {
    this.assertWritable();
    await this.ensureDir();
    const file = this.resolve(relative);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await withFileLock(file, () => atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`));
  }

  /** Deletes a store-relative file. Returns false when it did not exist. */
  async remove(relative: string): Promise<boolean> {
    this.assertWritable();
    try {
      await unlink(this.resolve(relative));
      return true;
    } catch (error) {
      if (errno(error) === "ENOENT") return false;
      throw error;
    }
  }

  /** Mode findings for the directory and files (for `doctor`). Missing files are skipped. */
  async inspectPermissions(): Promise<PermissionFinding[]> {
    if (this.options.memory || !this.paths.posixModes) return [];
    const findings: PermissionFinding[] = [];
    const check = async (target: string, expected: number): Promise<void> => {
      try {
        const info = await stat(target);
        const actual = info.mode & 0o777;
        findings.push({
          path: target,
          expected: expected.toString(8).padStart(4, "0"),
          actual: actual.toString(8).padStart(4, "0"),
          ok: (actual & ~expected) === 0,
        });
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
      }
    };
    await check(this.paths.dir, 0o700);
    await check(this.paths.credentialsFile, 0o600);
    await check(this.paths.configFile, 0o600);
    await check(this.paths.pendingGrantFile, 0o600);
    return findings;
  }

  /** chmod every finding back to its expected mode; returns the paths changed. */
  async fixPermissions(): Promise<string[]> {
    this.assertWritable();
    const changed: string[] = [];
    for (const finding of await this.inspectPermissions()) {
      if (finding.ok) continue;
      await chmod(finding.path, Number.parseInt(finding.expected, 8));
      changed.push(finding.path);
    }
    return changed;
  }
}

// ---------------------------------------------------------------------------
// Resolution (plan §5 "Resolution order")
// ---------------------------------------------------------------------------

export type ProfileSource = "flag" | "env" | "project" | "config" | "default";
export type KeyResolutionSource = "env" | "legacy_env" | "store" | "demo";
export type AgentIdSource = "flag" | "env" | "project" | "profile" | "demo";

/** A resolved key and where it came from. `value` is secret: never print it; use `redactKey`. */
export interface ResolvedKey {
  value: string;
  source: KeyResolutionSource;
  /** Environment variable when `source` is `env`/`legacy_env`. */
  variable?: string;
  /** Origin a store key is bound to (null for env keys: they may go to any allowed base). */
  origin: string | null;
  profile?: string;
  readRecord?: ReadKeyRecord;
  visitorRecord?: VisitorRecord;
}

export interface ResolvedCredentials {
  profile: { name: string; source: ProfileSource; exists: boolean };
  storeProfile: ProfileRecord | null;
  read: ResolvedKey | null;
  visitor: ResolvedKey | null;
  agentId: { value: string; source: AgentIdSource } | null;
}

export interface ResolveInput {
  env: Env;
  flags: { profile?: string; agent?: string };
  credentials: CredentialsFile;
  config: ConfigFile;
  project: ProjectConfig | null;
  warn?: WarnFn;
}

function validProfileName(value: string, from: string): string {
  if (!PROFILE_NAME_PATTERN.test(value)) {
    throw new CliError("INVALID_FLAG_VALUE", `${from} must match ^[a-z0-9-]{1,32}$.`, { humanDecision: false });
  }
  return value;
}

/** Profile: `--profile` → `ARCOPOLIS_PROFILE` → `arcopolis.json` → `config.defaultProfile` → `default`. */
export function resolveProfileName(input: Pick<ResolveInput, "env" | "flags" | "config" | "project">): {
  name: string;
  source: ProfileSource;
} {
  if (input.flags.profile) return { name: validProfileName(input.flags.profile, "--profile"), source: "flag" };
  const fromEnv = input.env.ARCOPOLIS_PROFILE?.trim();
  if (fromEnv) return { name: validProfileName(fromEnv, "ARCOPOLIS_PROFILE"), source: "env" };
  if (input.project?.profile) return { name: input.project.profile, source: "project" };
  if (input.config.defaultProfile) return { name: input.config.defaultProfile, source: "config" };
  return { name: "default", source: "default" };
}

function originFor(record: { origin?: string | null }, profile: ProfileRecord): string | null {
  if (typeof record.origin === "string" && record.origin) return record.origin;
  if (typeof profile.apiBase === "string" && profile.apiBase) {
    try {
      return new URL(profile.apiBase).origin;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolves profile, read key, visitor key, and agent id with their sources
 * (plan §5). Pure: reads nothing from disk.
 *
 * - Read key: `ARCOPOLIS_API_KEY` → legacy `AGNTS_API_KEY` (deprecation
 *   warning) → profile `readKey`.
 * - Visitor key: `ARCOPOLIS_VISITOR_API_KEY` → `ARCOPOLIS_API_KEY` only when
 *   `ARCOPOLIS_VISITOR_AGENT_ID` is set in the environment and no visitor key
 *   is available → profile `visitor.key`.
 * - Agent id: `--agent` → `ARCOPOLIS_VISITOR_AGENT_ID` → `arcopolis.json` → profile.
 */
export function resolveCredentials(input: ResolveInput): ResolvedCredentials {
  const profileName = resolveProfileName(input);
  const storeProfile = input.credentials.profiles[profileName.name] ?? null;
  const env = input.env;

  let read: ResolvedKey | null = null;
  const envRead = env.ARCOPOLIS_API_KEY?.trim();
  const legacyRead = env.AGNTS_API_KEY?.trim();
  if (envRead) {
    read = { value: envRead, source: "env", variable: "ARCOPOLIS_API_KEY", origin: null };
  } else if (legacyRead) {
    input.warn?.("DEPRECATED_ENV", "AGNTS_API_KEY is deprecated; rename it to ARCOPOLIS_API_KEY.");
    read = { value: legacyRead, source: "legacy_env", variable: "AGNTS_API_KEY", origin: null };
  } else if (storeProfile?.readKey?.key) {
    read = {
      value: storeProfile.readKey.key,
      source: "store",
      origin: originFor(storeProfile.readKey, storeProfile),
      profile: profileName.name,
      readRecord: storeProfile.readKey,
    };
  }

  let visitor: ResolvedKey | null = null;
  const envVisitor = env.ARCOPOLIS_VISITOR_API_KEY?.trim();
  const envAgent = env.ARCOPOLIS_VISITOR_AGENT_ID?.trim();
  if (envVisitor) {
    visitor = { value: envVisitor, source: "env", variable: "ARCOPOLIS_VISITOR_API_KEY", origin: null };
  } else if (envAgent && envRead && !storeProfile?.visitor?.key) {
    visitor = { value: envRead, source: "env", variable: "ARCOPOLIS_API_KEY", origin: null };
  } else if (storeProfile?.visitor?.key) {
    visitor = {
      value: storeProfile.visitor.key,
      source: "store",
      origin: originFor(storeProfile.visitor, storeProfile),
      profile: profileName.name,
      visitorRecord: storeProfile.visitor,
    };
  }

  let agentId: ResolvedCredentials["agentId"] = null;
  if (input.flags.agent) {
    if (!AGENT_ID_PATTERN.test(input.flags.agent)) {
      throw new CliError("INVALID_FLAG_VALUE", "--agent must match ^[A-Za-z0-9_:.-]{1,240}$.", { humanDecision: false });
    }
    agentId = { value: input.flags.agent, source: "flag" };
  } else if (envAgent) {
    if (!AGENT_ID_PATTERN.test(envAgent)) {
      throw new CliError("INVALID_FLAG_VALUE", "ARCOPOLIS_VISITOR_AGENT_ID must match ^[A-Za-z0-9_:.-]{1,240}$.", {
        humanDecision: false,
      });
    }
    agentId = { value: envAgent, source: "env" };
  } else if (input.project?.visitor?.agentId) {
    agentId = { value: input.project.visitor.agentId, source: "project" };
  } else if (storeProfile?.visitor?.agentId) {
    agentId = { value: storeProfile.visitor.agentId, source: "profile" };
  }

  return {
    profile: { ...profileName, exists: storeProfile !== null },
    storeProfile,
    read,
    visitor,
    agentId,
  };
}
