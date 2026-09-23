/**
 * Low-level file helpers shared by the store, the env file, `.gitignore`
 * edits, and the visitor state file: atomic 0600 writes and `O_EXCL` locks.
 */
import { randomUUID } from "node:crypto";
import { chmod, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.js";

/** `error.code` of a Node system error, if any. */
export function errno(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

/**
 * Atomic write (the starter's `writeState` pattern): temp file opened `wx`
 * at `mode`, write, fsync, close, rename over the target, chmod.
 */
export async function atomicWriteFile(file: string, content: string, mode = 0o600): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    await chmod(file, mode);
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error: unknown) => {
      if (errno(error) !== "ENOENT") throw error;
    });
  }
}

export interface LockOptions {
  /** How long to wait for a held lock before `STATE_LOCKED` (default 2 s). */
  waitMs?: number;
  pollMs?: number;
}

/**
 * Runs `fn` while holding `<file>.lock` (created with `O_EXCL`). A lock that
 * stays held past `waitMs` gives `STATE_LOCKED` (exit 13). Stale locks are
 * never removed automatically.
 */
export async function withFileLock<T>(file: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + (options.waitMs ?? 2_000);
  const pollMs = options.pollMs ?? 50;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  for (;;) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new CliError("STATE_LOCKED", `State is locked by another command: ${lockPath}.`, {
          hint: "If a previous process crashed, verify it has stopped before removing only the lock file.",
          details: { lockFile: lockPath },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    return await fn();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

