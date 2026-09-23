/**
 * Project config `arcopolis.json` (plan §5). It may be committed and is
 * treated as untrusted: only `profile`, `visitor.agentId`, and `stateFile`
 * are honored. Bases, keys, `writePolicy`, and anything else are ignored
 * with a warning, so a cloned repo can never redirect stored keys.
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const PROJECT_FILE = "arcopolis.json";
export const PROJECT_SCHEMA_URL = "https://api.arcopolis.ai/cli/arcopolis.schema.json";
export const DEFAULT_STATE_FILE = ".arcopolis-pending.json";

export const PROFILE_PATTERN = /^[a-z0-9-]{1,32}$/;
export const PROJECT_AGENT_ID_PATTERN = /^[A-Za-z0-9_:.-]{1,240}$/;
export const STATE_FILE_PATTERN = /^\.arcopolis-[A-Za-z0-9._-]+\.json$/;

/** The honored subset of `arcopolis.json`. */
export interface ProjectConfig {
  profile?: string;
  visitor?: { agentId?: string };
  /** Relative to the project root; always matches `.arcopolis-*.json` (so `.gitignore` covers it). Absent: `.arcopolis-pending.json` in cwd. */
  stateFile?: string;
}

export interface ProjectLocation {
  /** Directory holding `arcopolis.json`, else the git root, else cwd. */
  root: string;
  gitRoot: string | null;
}

export interface LoadedProject extends ProjectLocation {
  /** Absolute path of the file that was read, or null when none exists. */
  file: string | null;
  config: ProjectConfig;
  /** Human-readable reasons fields were ignored. */
  warnings: string[];
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Nearest ancestor of `cwd` (inclusive) that contains `.git` (a directory or a worktree file). */
export async function findGitRoot(cwd: string): Promise<string | null> {
  let current = path.resolve(cwd);
  for (;;) {
    if (await exists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Synchronous {@link findGitRoot} (used where a path is needed before any await). */
export function findGitRootSync(cwd: string): string | null {
  let current = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Looks for `arcopolis.json` from `cwd` up to the git root (inclusive). Outside
 * a git repository only `cwd` is checked.
 */
export async function findProjectFile(cwd: string): Promise<{ file: string | null } & ProjectLocation> {
  const gitRoot = await findGitRoot(cwd);
  let current = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(current, PROJECT_FILE);
    if (await exists(candidate)) return { file: candidate, root: current, gitRoot };
    if (!gitRoot || current === gitRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { file: null, root: gitRoot ?? path.resolve(cwd), gitRoot };
}

/**
 * Keeps only the allowed fields with valid values. Everything else becomes
 * a warning (and is dropped).
 */
export function sanitizeProjectConfig(raw: unknown): { config: ProjectConfig; warnings: string[] } {
  const warnings: string[] = [];
  const config: ProjectConfig = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { config, warnings: [`${PROJECT_FILE} must be a JSON object; it was ignored.`] };
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    switch (key) {
      case "$schema":
        break;
      case "schemaVersion":
        if (value !== 1) warnings.push(`${PROJECT_FILE} schemaVersion ${JSON.stringify(value)} is not 1; reading known fields only.`);
        break;
      case "profile":
        if (typeof value === "string" && PROFILE_PATTERN.test(value)) config.profile = value;
        else warnings.push(`${PROJECT_FILE} "profile" must match ^[a-z0-9-]{1,32}$; it was ignored.`);
        break;
      case "visitor": {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          warnings.push(`${PROJECT_FILE} "visitor" must be an object; it was ignored.`);
          break;
        }
        for (const [field, inner] of Object.entries(value as Record<string, unknown>)) {
          if (field === "agentId" && typeof inner === "string" && PROJECT_AGENT_ID_PATTERN.test(inner)) {
            config.visitor = { agentId: inner };
          } else if (field === "agentId") {
            warnings.push(`${PROJECT_FILE} "visitor.agentId" is not a valid agent id; it was ignored.`);
          } else {
            warnings.push(`${PROJECT_FILE} "visitor.${field}" is not allowed in a project file; it was ignored.`);
          }
        }
        break;
      }
      case "stateFile":
        if (typeof value === "string" && STATE_FILE_PATTERN.test(value)) config.stateFile = value;
        else warnings.push(`${PROJECT_FILE} "stateFile" must match .arcopolis-*.json in the project root; it was ignored.`);
        break;
      default:
        warnings.push(`${PROJECT_FILE} field "${key}" is not allowed in a project file (bases, keys, and writePolicy never are); it was ignored.`);
    }
  }
  return { config, warnings };
}

/** Finds and reads `arcopolis.json`. A missing file is not an error; invalid JSON is a warning. */
export async function loadProjectConfig(cwd: string): Promise<LoadedProject> {
  const location = await findProjectFile(cwd);
  if (!location.file) return { ...location, config: {}, warnings: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(location.file, "utf8"));
  } catch {
    return { ...location, config: {}, warnings: [`${PROJECT_FILE} is not valid JSON; it was ignored.`] };
  }
  const { config, warnings } = sanitizeProjectConfig(raw);
  return { ...location, config, warnings };
}

/**
 * Absolute path of the visitor state file: `--state` (relative to cwd) →
 * the project's explicit `stateFile` (relative to the project root) →
 * `.arcopolis-pending.json` in cwd, exactly where the starter looks, so the
 * CLI and a starter run from the same directory share one state file.
 */
export function resolveStateFile(project: LoadedProject, cwd: string, override?: string): string {
  if (override) return path.resolve(cwd, override);
  if (project.config.stateFile) return path.join(project.root, project.config.stateFile);
  return path.resolve(cwd, DEFAULT_STATE_FILE);
}

/**
 * When `arcopolis.json` moves the state file away from cwd and a starter-style
 * `.arcopolis-pending.json` also exists in cwd, the two tools would each see
 * only their own pending action. Returns that cwd file (a split to refuse),
 * else null. An explicit `--state` is the caller's choice and never a split.
 */
export function stateFileSplit(project: LoadedProject, cwd: string, override?: string): string | null {
  if (override || !project.config.stateFile) return null;
  const starterFile = path.resolve(cwd, DEFAULT_STATE_FILE);
  if (resolveStateFile(project, cwd) === starterFile) return null;
  return existsSync(starterFile) ? starterFile : null;
}

/** Skeleton written by `init` when no project file exists. */
export function projectSkeleton(): Record<string, unknown> {
  return { $schema: PROJECT_SCHEMA_URL, schemaVersion: 1, profile: "default" };
}
