/** Shared test helpers: captured streams, temp dirs, and an in-process CLI runner. */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { runCli, type CliRuntime } from "../src/cli/main.js";
import type { FetchLike } from "../src/core/http.js";

/** A writable that records everything written to it. */
export class Capture extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    callback();
  }
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Parsed stdout when it is exactly one JSON document. */
  json: Record<string, unknown> | null;
}

/** Runs the CLI in-process with non-TTY streams and an isolated config dir. */
export async function run(argv: string[], overrides: Partial<CliRuntime> = {}): Promise<RunResult> {
  const stdout = new Capture();
  const stderr = new Capture();
  const stdin = new PassThrough();
  const exitCode = await runCli({
    argv,
    env: { ARCOPOLIS_CONFIG_DIR: path.join(os.tmpdir(), "arcopolis-test-unused") },
    cwd: os.tmpdir(),
    stdin,
    stdout,
    stderr,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    // Never read the developer's real ~/.config/arcopolis (its writePolicy is a floor for every store).
    homedir: path.join(os.tmpdir(), "arcopolis-test-home-unused"),
    // Deterministic next[] form regardless of how the developer installed arcopolis.
    installKind: "source",
    ...overrides,
  });
  let json: Record<string, unknown> | null = null;
  const lines = stdout.text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 1) {
    try {
      json = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    } catch {
      json = null;
    }
  }
  return { exitCode, stdout: stdout.text, stderr: stderr.text, json };
}

/** Creates a temp directory and returns it with a cleanup function. */
export async function tempDir(prefix = "arcopolis-cli-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** One recorded fetch call. */
export interface RecordedCall {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
}

/** A fetch fake that records calls and answers with `respond`. */
export function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url, init, headers });
    return respond(url, init);
  };
  return { fetchImpl, calls };
}

/** JSON response helper. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** A valid-looking synthetic key (64 hex). */
export function fakeKey(char = "a"): string {
  return `agnts_${char.repeat(64)}`;
}

// ---------------------------------------------------------------------------
// The built CLI as a real process (dist/bin.js)
// ---------------------------------------------------------------------------

/** The package root (`cli/`). */
export const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Newest modification time under `dir` (ms), over files whose name matches `pattern`. */
function newestMtime(dir: string, pattern: RegExp): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full, pattern));
    else if (pattern.test(entry.name)) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

/**
 * Path of the built `dist/bin.js`. Throws when it is missing or older than
 * any source file, so a process test never passes against a stale build.
 */
export function builtBin(): string {
  const bin = path.join(CLI_ROOT, "dist", "bin.js");
  if (!existsSync(bin)) throw new Error("dist/bin.js is missing: run `npm run build` before these tests.");
  const sourceMtime = newestMtime(path.join(CLI_ROOT, "src"), /\.(ts|json|md|mdc)$/);
  if (statSync(bin).mtimeMs + 1 < sourceMtime) {
    throw new Error("dist/bin.js is older than src/: run `npm run build` before these tests.");
  }
  return bin;
}

/** Outcome of one spawned CLI process. */
export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  /** True when the process was killed at the deadline. */
  killed: boolean;
}

/** Options for {@link spawnCli}. */
export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  /** Extra `node` arguments before the script (for example `--import <preload>`). */
  nodeArgs?: string[];
  /** Written to stdin. */
  input?: string;
  /** Close stdin after `input` (default true). False leaves the pipe open, like an agent harness. */
  closeStdin?: boolean;
  /** SIGKILL after this many ms. */
  killAfterMs: number;
}

/** Runs `node dist/bin.js …args` as a real child process and collects its output. */
export function spawnCli(args: string[], options: SpawnOptions): Promise<ProcessResult> {
  const bin = builtBin();
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [...(options.nodeArgs ?? []), bin, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.stdin.on("error", () => undefined);
    if (options.input !== undefined) child.stdin.write(options.input);
    if (options.closeStdin ?? true) child.stdin.end();
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, options.killAfterMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({ exitCode: code, stdout, stderr, ms: Date.now() - started, killed });
    });
  });
}

/** A minimal child environment: PATH plus the given variables (nothing else leaks in from the test runner). */
export function childEnv(extra: Record<string, string>): Record<string, string> {
  return { PATH: process.env.PATH ?? "", LANG: "C", ...extra };
}

/** Unredacted key material: any `agnts_` key with 16 or more hex characters. */
export const RAW_KEY_PATTERN = /agnts_(?:[a-z]+_)*[0-9a-f]{16,}/;
