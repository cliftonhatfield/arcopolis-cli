/**
 * Env file writer (plan §5 "Env file"). The file is written only when git
 * does not track it and does ignore it; otherwise the path is first added
 * to the `.gitignore` managed block (after a TTY prompt or `--yes`). The CLI
 * manages only its own `# arcopolis:start` … `# arcopolis:end` block, writes
 * at 0600, and reports variable names with redacted previews only.
 */
import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./files.js";
import { CliError } from "./errors.js";
import {
  BLOCK_END,
  BLOCK_START,
  ensureGitignore,
  gitIsIgnored,
  gitIsTracked,
  readManagedLines,
  upsertManagedBlock,
  type GitignoreResult,
} from "./gitignore.js";
import { redact } from "./redact.js";

/** Variables the CLI may write, in this order. */
export const ENV_VARIABLES: readonly string[] = [
  "ARCOPOLIS_API_BASE",
  "ARCOPOLIS_API_KEY",
  "ARCOPOLIS_VISITOR_API_KEY",
  "ARCOPOLIS_VISITOR_AGENT_ID",
];

const SAFE_VALUE = /^[A-Za-z0-9_:./@+-]*$/;

function formatValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new CliError("INTERNAL", "Env values cannot contain newlines.");
  if (SAFE_VALUE.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Renders the managed block body (`NAME=value` lines in {@link ENV_VARIABLES} order). */
export function renderEnvLines(vars: Readonly<Record<string, string | undefined>>): string[] {
  const lines: string[] = [];
  for (const name of ENV_VARIABLES) {
    const value = vars[name];
    if (value !== undefined && value !== "") lines.push(`${name}=${formatValue(value)}`);
  }
  for (const [name, value] of Object.entries(vars)) {
    if (ENV_VARIABLES.includes(name) || value === undefined || value === "") continue;
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new CliError("INTERNAL", `Invalid env variable name ${name}.`);
    lines.push(`${name}=${formatValue(value)}`);
  }
  return lines;
}

/** Replaces the managed block in env file text. Idempotent. */
export function upsertEnvBlock(content: string, vars: Readonly<Record<string, string | undefined>>): {
  content: string;
  changed: boolean;
} {
  return upsertManagedBlock(content, renderEnvLines(vars), BLOCK_START, BLOCK_END);
}

/** Variable names currently inside the managed block. */
export function managedEnvNames(content: string): string[] {
  const lines = readManagedLines(content) ?? [];
  return lines.map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1]).filter((name): name is string => Boolean(name));
}

/** What `env status` reports about one env file. */
export interface EnvFileInspection {
  path: string;
  exists: boolean;
  mode: string | null;
  repo: boolean;
  tracked: boolean;
  ignored: boolean;
  managedVariables: string[];
}

/** Inspects an env file without printing any value. */
export async function inspectEnvFile(root: string, file: string): Promise<EnvFileInspection> {
  const target = path.resolve(root, file);
  let exists = false;
  let mode: string | null = null;
  let managedVariables: string[] = [];
  try {
    const info = await stat(target);
    exists = true;
    mode = (info.mode & 0o777).toString(8).padStart(4, "0");
    managedVariables = managedEnvNames(await readFile(target, "utf8"));
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const tracked = await gitIsTracked(root, target);
  const ignored = await gitIsIgnored(root, target);
  return {
    path: target,
    exists,
    mode,
    repo: tracked.repo || ignored.repo,
    tracked: tracked.result,
    ignored: ignored.result,
    managedVariables,
  };
}

export interface EnvFileWriteOptions {
  /** Project root (git root); `.gitignore` lives here. */
  root: string;
  /** Env file path, absolute or relative to `root`. */
  file: string;
  vars: Readonly<Record<string, string | undefined>>;
  /**
   * Asked before adding the file to `.gitignore`. Return true for `--yes` or a
   * TTY `y`; a non-interactive `promptConfirm` throws `CONFIRMATION_REQUIRED`.
   */
  confirmGitignore: (relativePath: string) => Promise<boolean>;
}

export interface EnvFileWriteResult {
  path: string;
  action: "created" | "updated" | "unchanged";
  gitignore: GitignoreResult | null;
  /** Names and redacted previews only. */
  variables: Array<{ name: string; preview: string }>;
  inRepo: boolean;
}

function gitUnknown(relative: string): CliError {
  return new CliError("ENV_FILE_NOT_IGNORED", `git could not tell whether ${relative} is tracked or ignored, so it was not written.`, {
    hint: "Use a plain path inside the repository (not through a symbolic link), with git installed.",
    humanDecision: true,
  });
}

/**
 * Writes the managed block. Refuses a symbolic link (`INVALID_PATH`), a
 * tracked file (`ENV_FILE_TRACKED`, exit 2), and a file git cannot answer
 * for. When the file is not ignored, asks `confirmGitignore`, adds the path
 * to the `.gitignore` managed block, and re-checks; a declined prompt gives
 * `ENV_FILE_NOT_IGNORED` (exit 2).
 */
export async function writeEnvFile(options: EnvFileWriteOptions): Promise<EnvFileWriteResult> {
  const target = path.resolve(options.root, options.file);
  const relative = path.relative(options.root, target);
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new CliError("INVALID_PATH", `${relative} is a symbolic link; keys are never written through one.`, { humanDecision: true });
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const insideRoot = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  // A path outside the project root is outside its repository: git has nothing to say about it.
  const tracked = insideRoot ? await gitIsTracked(options.root, target) : { repo: false, result: false, unknown: false };
  if (tracked.unknown) throw gitUnknown(relative);
  if (tracked.result) {
    throw new CliError("ENV_FILE_TRACKED", `${relative} is tracked by git; refusing to write secrets into it.`, {
      hint: "Choose an untracked path such as .env.arcopolis, or remove the file from git first.",
      humanDecision: true,
    });
  }
  let gitignore: GitignoreResult | null = null;
  if (tracked.repo) {
    const ignored = await gitIsIgnored(options.root, target);
    if (ignored.unknown) throw gitUnknown(relative);
    if (!ignored.result) {
      if (!(await options.confirmGitignore(relative))) {
        throw new CliError("ENV_FILE_NOT_IGNORED", `${relative} is not ignored by git, so it was not written.`, {
          hint: "Re-run with --yes to add it to the .gitignore managed block first.",
          humanDecision: true,
        });
      }
      gitignore = await ensureGitignore(options.root, [relative]);
      const recheck = await gitIsIgnored(options.root, target);
      if (!recheck.result) {
        throw new CliError("ENV_FILE_NOT_IGNORED", `${relative} is still not ignored after updating .gitignore.`, {
          hint: "A negation rule may re-include it; check .gitignore.",
          humanDecision: true,
        });
      }
    }
  }
  let content = "";
  let existed = true;
  try {
    content = await readFile(target, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    existed = false;
  }
  const update = upsertEnvBlock(content, options.vars);
  if (update.changed || !existed) await atomicWriteFile(target, update.content, 0o600);
  const variables = renderEnvLines(options.vars).map((line) => {
    const [name, ...rest] = line.split("=");
    return { name: name ?? "", preview: redact(rest.join("=")) };
  });
  return {
    path: target,
    action: !existed ? "created" : update.changed ? "updated" : "unchanged",
    gitignore,
    variables,
    inRepo: tracked.repo,
  };
}
