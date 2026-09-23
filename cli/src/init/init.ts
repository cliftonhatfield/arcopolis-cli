/**
 * `arcopolis init` engine (plan §7): the agent-instruction drop.
 *
 * Local only: no network and no credentials. Every edit is idempotent.
 * Markdown and rule files get a managed block between
 * `<!-- arcopolis:start v2 … -->` and `<!-- arcopolis:end -->` that is replaced
 * in place (a block of any earlier version is upgraded the same way); MCP JSON files are merged so other servers survive; `.gitignore`
 * gets the `# arcopolis:start` block; `arcopolis.json` is created only when
 * missing. The Codex user config is never edited: its TOML is returned as data.
 *
 * The work is split into {@link planInit} (reads only) and
 * {@link applyInitPlan} (writes exactly the planned files), so `--dry-run` and
 * `--demo` print the same plan a real run would apply.
 */
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../core/errors.js";
import { atomicWriteFile, errno } from "../core/files.js";
import { DEFAULT_IGNORE_ENTRIES, readManagedLines, upsertManagedBlock } from "../core/gitignore.js";
import { PROJECT_FILE, findProjectFile, projectSkeleton } from "../core/project.js";
import { AGENTS_BLOCK, BLOCK_VERSION, CURSOR_RULE_TEMPLATE, SKILL_TEMPLATE } from "./templates.js";

/** Values of `--agent`. */
export const INIT_AGENTS = ["auto", "claude", "codex", "cursor", "generic", "all", "none"] as const;
export type InitAgent = (typeof INIT_AGENTS)[number];

/** Concrete targets an `--agent` value expands to (in this order). */
export type InitTarget = "generic" | "codex" | "claude" | "cursor";
const TARGET_ORDER: readonly InitTarget[] = ["generic", "codex", "claude", "cursor"];

/** How the running CLI was installed; decides the MCP stanza command. */
export type InstallKind = "global" | "npx" | "local" | "source";

/** Start marker prefix (any block version). */
export const BLOCK_START_PREFIX = "<!-- arcopolis:start";
/** End marker line. */
export const BLOCK_END_LINE = "<!-- arcopolis:end -->";
/** MCP server name in `.mcp.json`, `.cursor/mcp.json`, and the Codex snippet. */
export const MCP_SERVER_NAME = "arcopolis";
/** Where immutable CLI tarballs are served (plan §9). */
export const TARBALL_BASE = "https://api.arcopolis.ai/downloads";

/** Project-relative paths `init` may write. */
export const INIT_PATHS = {
  agents: "AGENTS.md",
  claude: "CLAUDE.md",
  claudeMcp: ".mcp.json",
  skill: ".claude/skills/arcopolis/SKILL.md",
  cursorRule: ".cursor/rules/arcopolis.mdc",
  cursorMcp: ".cursor/mcp.json",
  gitignore: ".gitignore",
  project: PROJECT_FILE,
} as const;

/** One MCP server entry (`mcpServers.arcopolis`). */
export interface McpServerStanza {
  command: string;
  args: string[];
}

/** What happened (or, in a dry run, would happen) to one file. */
export type FileAction = "created" | "created_block" | "updated_block" | "merged" | "updated" | "unchanged" | "skipped";

/** One entry of `data.files`. Paths are project-relative with `/` separators. */
export interface InitFileReport {
  path: string;
  action: FileAction;
  block?: string;
  reason?: string;
  server?: string;
  command?: string;
  args?: string[];
  added?: string[];
  /** The real file written when `path` is a symlink inside the project. */
  resolvedPath?: string;
}

/** A planned file: its report, and the write to perform (absent when nothing changes). */
export interface PlannedFile {
  report: InitFileReport;
  write?: { file: string; content: string; mode: number };
}

export interface InitOptions {
  cwd: string;
  agent: InitAgent;
  mcp: boolean;
  mcpWrites: boolean;
  skill: boolean;
  /** CLI version pinned into the npx tarball URL. */
  version: string;
  install: InstallKind;
}

export interface InitPlan {
  /** Absolute project root: the directory holding `arcopolis.json`, else the git root, else cwd. */
  root: string;
  /** Resolved `--agent` label (`auto` only when several targets were detected). */
  agent: string;
  targets: InitTarget[];
  /** What `auto` found (`CLAUDE.md`, `.claude/`, `.cursor/`, `AGENTS.md`). */
  detected: string[];
  mcp: (McpServerStanza & { server: string; install: InstallKind; allowWrites: boolean }) | null;
  codexConfigSnippet: string | null;
  files: PlannedFile[];
  warnings: Array<{ code: string; message: string }>;
}

// ---------------------------------------------------------------------------
// Managed Markdown block
// ---------------------------------------------------------------------------

/** Line-level scan result for a managed block. */
interface BlockScan {
  /** Index of the start-marker line, or -1. */
  start: number;
  /** Index of the end-marker line, or -1 (unterminated when `start` is set). */
  end: number;
}

/** Strips a trailing `\r`. */
function bare(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Finds the managed block, ignoring marker-looking lines inside fenced code. */
function scanBlock(lines: readonly string[]): BlockScan {
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = bare(lines[index] ?? "");
    if (/^ {0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line.startsWith(BLOCK_START_PREFIX)) continue;
    for (let end = index + 1; end < lines.length; end += 1) {
      if (bare(lines[end] ?? "") === BLOCK_END_LINE) return { start: index, end };
    }
    return { start: index, end: -1 };
  }
  return { start: -1, end: -1 };
}

/** Version tag of the managed block (`v1`), or null when the text has none. */
export function readBlockVersion(content: string): string | null {
  const lines = content.split("\n");
  const scan = scanBlock(lines);
  if (scan.start === -1) return null;
  const match = /^<!-- arcopolis:start (v\d+)\b/.exec(bare(lines[scan.start] ?? ""));
  return match?.[1] ?? null;
}

/** Result of {@link upsertMarkdownBlock}. */
export interface MarkdownBlockUpdate {
  content: string;
  changed: boolean;
  /** A block was already present (and replaced in place). */
  hadBlock: boolean;
  /** A start marker has no end marker; the text was left unchanged. */
  unterminated: boolean;
}

/**
 * Replaces the managed block in place, or appends it after one blank line.
 * Text outside the markers is preserved byte for byte, and CRLF files get a
 * CRLF block. Running it twice gives the same text.
 */
export function upsertMarkdownBlock(content: string, block: string): MarkdownBlockUpdate {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const blockText = block.replace(/\n$/, "").split("\n").join(eol);
  const lines = content.split("\n");
  const scan = scanBlock(lines);
  if (scan.start !== -1 && scan.end === -1) return { content, changed: false, hadBlock: true, unterminated: true };
  if (scan.start !== -1) {
    let startOffset = 0;
    for (let index = 0; index < scan.start; index += 1) startOffset += (lines[index] ?? "").length + 1;
    let endOffset = startOffset;
    for (let index = scan.start; index <= scan.end; index += 1) endOffset += (lines[index] ?? "").length + 1;
    // Keep the end line's own terminator (and a trailing `\r` before it) outside the replaced span.
    endOffset -= 1;
    if (content[endOffset - 1] === "\r") endOffset -= 1;
    const next = `${content.slice(0, startOffset)}${blockText}${content.slice(Math.min(endOffset, content.length))}`;
    return { content: next, changed: next !== content, hadBlock: true, unterminated: false };
  }
  if (content.length === 0) return { content: `${blockText}${eol}`, changed: true, hadBlock: false, unterminated: false };
  const separator = content.endsWith(`${eol}${eol}`) ? "" : content.endsWith("\n") ? eol : `${eol}${eol}`;
  return { content: `${content}${separator}${blockText}${eol}`, changed: true, hadBlock: false, unterminated: false };
}

/**
 * True when `CLAUDE.md` imports `AGENTS.md` with Claude Code's `@path` syntax
 * (`@AGENTS.md` or `@./AGENTS.md`), outside code fences and inline code.
 */
export function importsAgentsMd(content: string): boolean {
  let inFence = false;
  for (const raw of content.split("\n")) {
    const line = bare(raw);
    if (/^ {0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const text = line.replace(/`[^`]*`/g, "");
    if (/(^|\s)@(\.\/)?AGENTS\.md(?=$|[\s),.;:])/.test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// MCP stanza and install detection
// ---------------------------------------------------------------------------

/** The immutable tarball URL for a CLI version. */
export function tarballUrl(version: string): string {
  return `${TARBALL_BASE}/arcopolis-cli-${version}.tgz`;
}

/**
 * The MCP server command for how the CLI is running. A global install runs
 * `arcopolis mcp`; anything else runs the version-pinned tarball through
 * `npx --package=<url>` (the npm package name is not owned, so the bare
 * package form is never emitted). `writes` appends `--allow-writes`.
 */
export function mcpStanza(install: InstallKind, version: string, writes: boolean): McpServerStanza {
  const stanza: McpServerStanza =
    install === "global"
      ? { command: "arcopolis", args: ["mcp"] }
      : { command: "npx", args: ["-y", `--package=${tarballUrl(version)}`, "arcopolis", "mcp"] };
  if (writes) stanza.args.push("--allow-writes");
  return stanza;
}

/** TOML basic string (the JSON escapes are valid TOML for these values). */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** The Codex `~/.codex/config.toml` table for the stanza (returned as data; never written). */
export function codexConfigSnippet(stanza: McpServerStanza): string {
  return [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${tomlString(stanza.command)}`,
    `args = [${stanza.args.map(tomlString).join(", ")}]`,
    "required = false",
    "startup_timeout_sec = 45",
    "",
  ].join("\n");
}

/** Absolute path of this module (the default install probe). */
export function currentModuleFile(): string {
  return fileURLToPath(import.meta.url);
}

/** Inputs for {@link detectInstall}; injectable for tests. */
export interface InstallProbe {
  /** A file inside the running CLI package. */
  moduleFile: string;
  /** The `PATH` value (`Path` on Windows). */
  pathEnv: string | undefined;
  platform: NodeJS.Platform;
}

/** Nearest ancestor directory whose package.json is named `arcopolis`. */
function findPackageRoot(file: string): string | null {
  let current = path.dirname(file);
  for (;;) {
    const manifest = path.join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
        if (parsed.name === "arcopolis") return current;
      } catch {
        // Not our manifest; keep walking.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** True when `child` is `parent` or inside it. */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Detects how the CLI is running:
 * - `npx`: the package sits in npm's `_npx` cache;
 * - `global`: an `arcopolis` command on `PATH` (outside any `node_modules/.bin`)
 *   resolves into this same package, so an MCP client can launch `arcopolis mcp`;
 * - `local`: a project `node_modules` install;
 * - `source`: a checkout (`node dist/bin.js`, tests).
 * Only `global` yields the bare `arcopolis` command; the rest use the pinned tarball.
 */
export async function detectInstall(probe: InstallProbe): Promise<InstallKind> {
  const moduleFile = probe.moduleFile;
  if (/[\\/]_npx[\\/]/.test(moduleFile)) return "npx";
  const root = findPackageRoot(moduleFile);
  const packageRoot = root ? await realpath(root).catch(() => root) : null;
  const delimiter = probe.platform === "win32" ? ";" : ":";
  const names = probe.platform === "win32" ? ["arcopolis.cmd", "arcopolis.exe", "arcopolis"] : ["arcopolis"];
  const pathDirs = (probe.pathEnv ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && path.isAbsolute(entry) && !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(entry));
  if (packageRoot) {
    for (const dir of pathDirs) {
      for (const name of names) {
        const candidate = path.join(dir, name);
        if (!existsSync(candidate)) continue;
        const resolved = await realpath(candidate).catch(() => candidate);
        if (isInside(packageRoot, resolved)) return "global";
        // npm on Windows: `<prefix>\arcopolis.cmd` next to `<prefix>\node_modules\arcopolis`.
        if (
          probe.platform === "win32" &&
          path.basename(path.dirname(packageRoot)) === "node_modules" &&
          path.resolve(path.dirname(path.dirname(packageRoot))) === path.resolve(dir)
        ) {
          return "global";
        }
      }
    }
  }
  if (/[\\/]node_modules[\\/]arcopolis[\\/]/.test(moduleFile)) return "local";
  return "source";
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** A project path resolved through symlinks. */
interface ResolvedPath {
  rel: string;
  abs: string;
  /** Real path to read and write (symlinks followed; a missing file resolves through its nearest existing parent). */
  real: string;
  exists: boolean;
  isDirectory: boolean;
  outside: boolean;
  isSymlink: boolean;
}

/** Mutable state shared by the planners. */
interface PlanState {
  root: string;
  rootReal: string;
  files: PlannedFile[];
  warnings: Array<{ code: string; message: string }>;
  /** real path → project-relative path that already claimed it. */
  seen: Map<string, string>;
}

/** Project-relative POSIX form of an absolute path. */
function relPosix(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** Resolves `rel` under the root, following symlinks. */
async function resolvePath(state: PlanState, rel: string): Promise<ResolvedPath> {
  const abs = path.join(state.root, ...rel.split("/"));
  let isSymlink = false;
  let exists = false;
  let isDirectory = false;
  try {
    const info = await lstat(abs);
    isSymlink = info.isSymbolicLink();
    exists = true;
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
  let real: string;
  if (exists) {
    try {
      real = await realpath(abs);
      isDirectory = (await stat(real)).isDirectory();
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
      // A dangling symlink: treat as missing but never write through it.
      return { rel, abs, real: abs, exists: false, isDirectory: false, outside: true, isSymlink };
    }
  } else {
    let existing = path.dirname(abs);
    const tail: string[] = [path.basename(abs)];
    while (!existsSync(existing)) {
      tail.unshift(path.basename(existing));
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const base = await realpath(existing).catch(() => existing);
    real = path.join(base, ...tail);
  }
  return { rel, abs, real, exists, isDirectory, outside: !isInside(state.rootReal, real), isSymlink };
}

/** Existing file mode (permission bits) or the default for new project files. */
async function modeFor(target: ResolvedPath): Promise<number> {
  if (!target.exists) return 0o644;
  return (await stat(target.real)).mode & 0o777;
}

/**
 * Common checks before planning a write. Returns a report when the file must
 * be skipped or was already claimed by an earlier entry (a symlink alias).
 */
function precheck(state: PlanState, target: ResolvedPath): InitFileReport | null {
  if (target.outside) {
    const reason = target.isSymlink && !target.exists ? "dangling symlink; left as is" : "resolves outside the project; left as is";
    state.warnings.push({ code: "INIT_PATH_SKIPPED", message: `${target.rel} ${reason}.` });
    return { path: target.rel, action: "skipped", reason };
  }
  if (target.isDirectory) {
    state.warnings.push({ code: "INIT_PATH_SKIPPED", message: `${target.rel} is a directory; left as is.` });
    return { path: target.rel, action: "skipped", reason: "is a directory" };
  }
  const claimed = state.seen.get(target.real);
  if (claimed) return { path: target.rel, action: "unchanged", reason: `same file as ${claimed}` };
  return null;
}

/** Adds the resolved path to a report when the file is reached through a symlink. */
function withResolved(state: PlanState, target: ResolvedPath, report: InitFileReport): InitFileReport {
  if (target.isSymlink) report.resolvedPath = relPosix(state.rootReal, target.real);
  return report;
}

/**
 * Plans a Markdown/rule file carrying the managed block. A missing file is
 * created from `template`; an existing one gets the block upserted.
 */
async function planBlockFile(state: PlanState, rel: string, template: string): Promise<void> {
  const target = await resolvePath(state, rel);
  const skipped = precheck(state, target);
  if (skipped) {
    state.files.push({ report: skipped });
    return;
  }
  state.seen.set(target.real, rel);
  if (!target.exists) {
    state.files.push({
      report: withResolved(state, target, { path: rel, action: "created", block: BLOCK_VERSION }),
      write: { file: target.real, content: template, mode: 0o644 },
    });
    return;
  }
  const current = await readFile(target.real, "utf8");
  const update = upsertMarkdownBlock(current, AGENTS_BLOCK);
  if (update.unterminated) {
    state.warnings.push({
      code: "INIT_BLOCK_UNTERMINATED",
      message: `${rel} has "${BLOCK_START_PREFIX}" without "${BLOCK_END_LINE}"; fix the markers by hand, then re-run arcopolis init.`,
    });
    state.files.push({ report: { path: rel, action: "skipped", reason: "managed block has no end marker" } });
    return;
  }
  const action: FileAction = !update.hadBlock ? "created_block" : update.changed ? "updated_block" : "unchanged";
  state.files.push({
    report: withResolved(state, target, { path: rel, action, block: BLOCK_VERSION }),
    ...(update.changed ? { write: { file: target.real, content: update.content, mode: await modeFor(target) } } : {}),
  });
}

/** Plans `CLAUDE.md`: unchanged when it imports `@AGENTS.md` (unless it already carries a block to refresh). */
async function planClaudeMd(state: PlanState, claude: ResolvedPath, imports: boolean): Promise<void> {
  if (!imports) {
    await planBlockFile(state, INIT_PATHS.claude, AGENTS_BLOCK);
    return;
  }
  const skipped = precheck(state, claude);
  if (skipped) {
    state.files.push({ report: skipped });
    return;
  }
  const current = await readFile(claude.real, "utf8");
  if (scanBlock(current.split("\n")).start !== -1) {
    await planBlockFile(state, INIT_PATHS.claude, AGENTS_BLOCK);
    return;
  }
  state.seen.set(claude.real, INIT_PATHS.claude);
  state.files.push({ report: { path: INIT_PATHS.claude, action: "unchanged", reason: "imports @AGENTS.md" } });
}

/** True for a plain JSON object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Order-sensitive structural equality for JSON values. */
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Plans an MCP JSON file (`.mcp.json`, `.cursor/mcp.json`): sets
 * `mcpServers.arcopolis` to the stanza, keeping every other server and every
 * other key (including extra keys such as `env` on the arcopolis entry).
 */
async function planMcpJson(state: PlanState, rel: string, stanza: McpServerStanza): Promise<void> {
  const target = await resolvePath(state, rel);
  const skipped = precheck(state, target);
  const reportBase = { server: MCP_SERVER_NAME, command: stanza.command, args: [...stanza.args] };
  if (skipped) {
    state.files.push({ report: skipped });
    return;
  }
  state.seen.set(target.real, rel);
  if (!target.exists) {
    const content = `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: stanza } }, null, 2)}\n`;
    state.files.push({
      report: withResolved(state, target, { path: rel, action: "created", ...reportBase }),
      write: { file: target.real, content, mode: 0o644 },
    });
    return;
  }
  const text = await readFile(target.real, "utf8");
  let parsed: unknown;
  try {
    parsed = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const servers = isPlainObject(parsed) ? (parsed.mcpServers ?? {}) : undefined;
  if (!isPlainObject(parsed) || !isPlainObject(servers)) {
    const reason = "not a JSON object with an mcpServers object; left as is";
    state.warnings.push({ code: "INIT_MCP_JSON_INVALID", message: `${rel} is ${reason}. Add the arcopolis server by hand or fix the file and re-run.` });
    state.files.push({ report: { path: rel, action: "skipped", reason } });
    return;
  }
  const existing = servers[MCP_SERVER_NAME];
  const entry = { ...(isPlainObject(existing) ? existing : {}), command: stanza.command, args: [...stanza.args] };
  if (jsonEqual(existing, entry)) {
    state.files.push({ report: withResolved(state, target, { path: rel, action: "unchanged", ...reportBase }) });
    return;
  }
  const indentMatch = /\n([ \t]+)"/.exec(text);
  const indent = indentMatch?.[1] ?? 2;
  const merged = { ...parsed, mcpServers: { ...servers, [MCP_SERVER_NAME]: entry } };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const content = `${JSON.stringify(merged, null, indent).split("\n").join(eol)}${eol}`;
  state.files.push({
    report: withResolved(state, target, { path: rel, action: "merged", ...reportBase }),
    write: { file: target.real, content, mode: await modeFor(target) },
  });
}

/** Plans the `.gitignore` managed block (`.arcopolis-*`, `.arcopolis/`), keeping entries already in it. */
async function planGitignore(state: PlanState): Promise<void> {
  const rel = INIT_PATHS.gitignore;
  const target = await resolvePath(state, rel);
  const skipped = precheck(state, target);
  if (skipped) {
    state.files.push({ report: skipped });
    return;
  }
  state.seen.set(target.real, rel);
  const content = target.exists ? await readFile(target.real, "utf8") : "";
  const merged = (readManagedLines(content) ?? []).filter((line) => line.trim() !== "");
  const added: string[] = [];
  for (const entry of DEFAULT_IGNORE_ENTRIES) {
    if (!merged.includes(entry)) {
      merged.push(entry);
      added.push(entry);
    }
  }
  const update = upsertManagedBlock(content, merged);
  if (!update.changed) {
    state.files.push({ report: withResolved(state, target, { path: rel, action: "unchanged" }) });
    return;
  }
  state.files.push({
    report: withResolved(state, target, { path: rel, action: target.exists ? "updated" : "created", added }),
    write: { file: target.real, content: update.content, mode: await modeFor(target) },
  });
}

/** Plans the `arcopolis.json` skeleton (only when no project file exists). */
async function planProjectFile(state: PlanState, existingFile: string | null): Promise<void> {
  if (existingFile) {
    state.files.push({ report: { path: relPosix(state.root, existingFile), action: "unchanged", reason: "exists" } });
    return;
  }
  const rel = INIT_PATHS.project;
  const target = await resolvePath(state, rel);
  const skipped = precheck(state, target);
  if (skipped) {
    state.files.push({ report: skipped });
    return;
  }
  state.seen.set(target.real, rel);
  state.files.push({
    report: { path: rel, action: "created" },
    write: { file: target.real, content: `${JSON.stringify(projectSkeleton(), null, 2)}\n`, mode: 0o644 },
  });
}

/** Which agent markers exist at the root (for `--agent auto`). */
async function detectAgents(root: string): Promise<string[]> {
  const found: string[] = [];
  const probe = async (rel: string, wantDirectory: boolean): Promise<boolean> => {
    try {
      const info = await stat(path.join(root, rel));
      return wantDirectory ? info.isDirectory() : info.isFile();
    } catch {
      return false;
    }
  };
  if (await probe(INIT_PATHS.claude, false)) found.push("CLAUDE.md");
  if (await probe(".claude", true)) found.push(".claude/");
  if (await probe(".cursor", true)) found.push(".cursor/");
  if (await probe(INIT_PATHS.agents, false)) found.push("AGENTS.md");
  return found;
}

/** Expands an `--agent` value into targets (and, for `auto`, what was detected). */
export async function resolveTargets(agent: InitAgent, root: string): Promise<{ targets: InitTarget[]; detected: string[] }> {
  if (agent === "none") return { targets: [], detected: [] };
  if (agent === "all") return { targets: [...TARGET_ORDER], detected: [] };
  if (agent !== "auto") return { targets: [agent], detected: [] };
  const detected = await detectAgents(root);
  const wanted = new Set<InitTarget>();
  if (detected.includes("AGENTS.md")) wanted.add("generic");
  if (detected.includes("CLAUDE.md") || detected.includes(".claude/")) wanted.add("claude");
  if (detected.includes(".cursor/")) wanted.add("cursor");
  if (wanted.size === 0) wanted.add("generic");
  return { targets: TARGET_ORDER.filter((target) => wanted.has(target)), detected };
}

/**
 * Plans every file `init` would touch. Reads only; nothing is written.
 * Order: AGENTS.md, CLAUDE.md, .mcp.json, SKILL.md, Cursor rule, Cursor MCP,
 * .gitignore, arcopolis.json.
 */
export async function planInit(options: InitOptions): Promise<InitPlan> {
  const location = await findProjectFile(options.cwd);
  const root = location.root;
  const state: PlanState = {
    root,
    rootReal: await realpath(root).catch(() => root),
    files: [],
    warnings: [],
    seen: new Map(),
  };
  const { targets, detected } = await resolveTargets(options.agent, root);
  const has = (target: InitTarget): boolean => targets.includes(target);
  const stanza = options.mcp ? mcpStanza(options.install, options.version, options.mcpWrites) : null;

  let claudeImports = false;
  let claudeTarget: ResolvedPath | null = null;
  if (has("claude")) {
    claudeTarget = await resolvePath(state, INIT_PATHS.claude);
    if (claudeTarget.exists && !claudeTarget.isDirectory && !claudeTarget.outside) {
      claudeImports = importsAgentsMd(await readFile(claudeTarget.real, "utf8"));
    }
  }

  if (has("generic") || has("codex") || claudeImports) await planBlockFile(state, INIT_PATHS.agents, AGENTS_BLOCK);
  if (claudeTarget) await planClaudeMd(state, claudeTarget, claudeImports);
  if (has("claude") && stanza) await planMcpJson(state, INIT_PATHS.claudeMcp, stanza);
  if (has("claude") && options.skill) await planBlockFile(state, INIT_PATHS.skill, SKILL_TEMPLATE);
  if (options.skill && !has("claude")) {
    state.warnings.push({
      code: "INIT_SKILL_IGNORED",
      message: "--skill applies only to the claude target; use --agent claude or --agent all to write .claude/skills/arcopolis/SKILL.md.",
    });
  }
  if (has("cursor")) await planBlockFile(state, INIT_PATHS.cursorRule, CURSOR_RULE_TEMPLATE);
  if (has("cursor") && stanza) await planMcpJson(state, INIT_PATHS.cursorMcp, stanza);
  await planGitignore(state);
  await planProjectFile(state, location.file);

  const agent = options.agent === "auto" ? (targets.length === 1 ? (targets[0] ?? "auto") : "auto") : options.agent;
  return {
    root,
    agent,
    targets,
    detected,
    mcp:
      stanza && targets.length > 0
        ? { server: MCP_SERVER_NAME, ...stanza, install: options.install, allowWrites: options.mcpWrites }
        : null,
    codexConfigSnippet: stanza && targets.length > 0 ? codexConfigSnippet(stanza) : null,
    files: state.files,
    warnings: state.warnings,
  };
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * Writes every planned change (atomic write, mode kept for existing files,
 * 0644 for new ones) and returns the project-relative paths written. A
 * permission failure throws `INIT_WRITE_FAILED` (exit 4) naming what was
 * already written.
 */
export async function applyInitPlan(plan: InitPlan): Promise<string[]> {
  const written: string[] = [];
  for (const file of plan.files) {
    if (!file.write) continue;
    try {
      await mkdir(path.dirname(file.write.file), { recursive: true });
      await atomicWriteFile(file.write.file, file.write.content, file.write.mode);
    } catch (error) {
      const code = errno(error);
      if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
        throw new CliError("INIT_WRITE_FAILED", `Could not write ${file.report.path} (${code}).`, {
          category: "forbidden",
          hint: "Check the directory's permissions, or run arcopolis init --dry-run to see the plan and apply it by hand.",
          details: { path: file.report.path, written },
        });
      }
      throw error;
    }
    written.push(file.report.path);
  }
  return written;
}
