/**
 * `.gitignore` managed block (plan §5) and the small git queries the CLI
 * needs (tracked? ignored?). Only the text between `# arcopolis:start` and
 * `# arcopolis:end` is ever edited.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.js";
import { atomicWriteFile, errno } from "./files.js";
import { findGitRootSync } from "./project.js";

export const BLOCK_START = "# arcopolis:start";
export const BLOCK_END = "# arcopolis:end";
export const DEFAULT_IGNORE_ENTRIES: readonly string[] = [".arcopolis-*", ".arcopolis/"];

/** Result of replacing a managed block in some text. */
export interface BlockUpdate {
  content: string;
  changed: boolean;
}

/** Lines between the markers, or null when the block is absent. */
export function readManagedLines(content: string, start = BLOCK_START, end = BLOCK_END): string[] | null {
  const lines = content.split(/\r?\n/);
  const from = lines.indexOf(start);
  if (from === -1) return null;
  const to = lines.indexOf(end, from + 1);
  if (to === -1) return null;
  return lines.slice(from + 1, to);
}

/**
 * Replaces (or appends) the managed block with `bodyLines`. Text outside the
 * markers is preserved byte for byte; appending adds one separating newline.
 */
export function upsertManagedBlock(
  content: string,
  bodyLines: readonly string[],
  start = BLOCK_START,
  end = BLOCK_END,
): BlockUpdate {
  const block = [start, ...bodyLines, end].join("\n");
  const lines = content.split("\n");
  const from = lines.findIndex((line) => line.replace(/\r$/, "") === start);
  const to = from === -1 ? -1 : lines.findIndex((line, index) => index > from && line.replace(/\r$/, "") === end);
  let next: string;
  if (from !== -1 && to !== -1) {
    next = [...lines.slice(0, from), block, ...lines.slice(to + 1)].join("\n");
  } else if (content.length === 0) {
    next = `${block}\n`;
  } else {
    next = `${content}${content.endsWith("\n") ? "" : "\n"}${block}\n`;
  }
  return { content: next, changed: next !== content };
}

/** Normalizes an ignore entry to a repo-relative POSIX pattern. */
function toEntry(entry: string): string {
  return entry.split(path.sep).join("/");
}

/** Result of {@link ensureGitignore}. */
export interface GitignoreResult {
  path: string;
  action: "created" | "updated" | "unchanged";
  added: string[];
}

function unsafeGitignore(file: string, what: string): CliError {
  return new CliError("GITIGNORE_SYMLINK", `${file} is ${what}; the CLI never reads or writes through it, and git does not honor it.`, {
    humanDecision: true,
    hint: "Replace it with a regular .gitignore file (a cloned repository can ship a link that points at a file outside the project).",
    details: { file },
  });
}

/**
 * Reads `.gitignore` without following a symbolic link: a committed link
 * could otherwise copy an arbitrary file from outside the project into the
 * working tree. Returns null when it does not exist; a link or a non-file is
 * `GITIGNORE_SYMLINK` (exit 2).
 */
async function readGitignore(file: string): Promise<string | null> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw unsafeGitignore(file, "a symbolic link");
    if (!info.isFile()) throw unsafeGitignore(file, "not a regular file");
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    return await handle.readFile("utf8");
  } catch (error) {
    if (errno(error) === "ELOOP") throw unsafeGitignore(file, "a symbolic link");
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Ensures `<root>/.gitignore` has the managed block with the default entries
 * plus `extraEntries` (e.g. an env file path). Existing managed entries are
 * kept, so the call is idempotent. A `.gitignore` that is a symbolic link is
 * refused, never followed.
 */
export async function ensureGitignore(root: string, extraEntries: readonly string[] = []): Promise<GitignoreResult> {
  const file = path.join(root, ".gitignore");
  const existing = await readGitignore(file);
  const existed = existing !== null;
  const content = existing ?? "";
  const current = readManagedLines(content) ?? [];
  const wanted = [...DEFAULT_IGNORE_ENTRIES, ...extraEntries.map(toEntry)];
  const merged = [...current.filter((line) => line.trim() !== "")];
  const added: string[] = [];
  for (const entry of wanted) {
    if (!merged.includes(entry)) {
      merged.push(entry);
      added.push(entry);
    }
  }
  const update = upsertManagedBlock(content, merged);
  if (!update.changed) return { path: file, action: "unchanged", added: [] };
  await atomicWriteFile(file, update.content, 0o644);
  return { path: file, action: existed ? "updated" : "created", added };
}

/**
 * Outcome of one git query. `repo` is false outside a repository. `unknown`
 * is true when the path is inside a repository but git could not answer (for
 * example the path goes through a symbolic link, or git is missing); callers
 * must then treat the file as neither ignored nor safe, never as ignored.
 */
export interface GitQuery {
  repo: boolean;
  result: boolean;
  unknown: boolean;
}

function runGit(cwd: string, args: string[]): Promise<{ code: number }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 10_000, windowsHide: true }, (error) => {
      if (!error) return resolve({ code: 0 });
      const code = typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : -1;
      resolve({ code });
    });
  });
}

/** Maps a git exit code: 0 yes, 1 no, anything else unknown inside a repository (fail closed). */
function queryResult(root: string, code: number): GitQuery {
  if (code === 0) return { repo: true, result: true, unknown: false };
  if (code === 1) return { repo: true, result: false, unknown: false };
  const repo = findGitRootSync(root) !== null;
  return { repo, result: false, unknown: repo };
}

/** `git ls-files --error-unmatch`: is the file tracked? */
export async function gitIsTracked(root: string, file: string): Promise<GitQuery> {
  const { code } = await runGit(root, ["ls-files", "--error-unmatch", "--", path.relative(root, path.resolve(root, file))]);
  return queryResult(root, code);
}

/** `git check-ignore -q`: would git ignore the file? */
export async function gitIsIgnored(root: string, file: string): Promise<GitQuery> {
  const { code } = await runGit(root, ["check-ignore", "-q", "--", path.relative(root, path.resolve(root, file))]);
  return queryResult(root, code);
}
