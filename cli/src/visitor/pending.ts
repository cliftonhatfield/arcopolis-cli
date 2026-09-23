/**
 * The visitor action state machine (plan §4.6), a port of the starter's
 * `executeAction` (`examples/arcopolis-starter/node/actions.mjs`).
 *
 * The state file is byte-compatible with the starter: schemaVersion 1 with
 * `schemaVersion, status, body, agentId, baseUrl, keyFingerprint,
 * idempotencyKey, createdAt, response?, completedAt?`, written as
 * `JSON.stringify(state, null, 2) + "\n"` at 0600 by atomic rename, guarded
 * by an `O_EXCL` `<state>.lock`. The exact request identity is persisted
 * **before** `POST /act`, and an uncertain outcome keeps the pending state
 * so the only resend reuses the same body and idempotency key.
 *
 * CLI rules on top of the starter: `visitor act` never resends a pending
 * action (the only resend is `visitor pending --retry --execute`), and a
 * first send that the server definitively refuses (see
 * {@link isDefinitiveRefusal}) restores the state file to what it held
 * before, since nothing took effect. Both outcomes leave a file the starter
 * reads unchanged: no new status is ever written.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { CliError } from "../core/errors.js";
import { atomicWriteFile, errno, withFileLock } from "../core/files.js";
import type { ApiResponse, HttpClient } from "../core/http.js";
import type { Effects } from "../core/output.js";
import {
  actionKindOf,
  assertHeartbeatVisitor,
  assertMenuAllows,
  assertNoSecretsInAction,
  keyFingerprint,
  outcomeUncertain,
  sameCanonical,
  sendHeartbeat,
  validateAction,
  visitorPath,
  type ActionBody,
  type ActionKind,
  type HeartbeatData,
} from "./actions.js";

/** The server's replay retention; a pending action older than this is never resent. */
export const REPLAY_WINDOW_MS = 86_400_000;

/** Statuses a confirmed act response may carry. */
export const CONFIRMED_STATUSES = ["created", "skipped", "blocked"] as const;

/** The state file (schemaVersion 1, starter-compatible). */
export interface PendingState {
  schemaVersion: 1;
  status: "pending" | "completed";
  body: ActionBody;
  agentId: string;
  baseUrl: string;
  /** sha256 hex of the API key; never the key itself. */
  keyFingerprint: string;
  idempotencyKey: string;
  createdAt: string;
  /** The full act response envelope `{data: …}` once completed. */
  response?: Record<string, unknown>;
  completedAt?: string;
}

/** The fields that bind a state file to one request. */
export interface ActionIdentity {
  body: ActionBody;
  agentId: string;
  baseUrl: string;
  keyFingerprint: string;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidState(message: string, details?: Json): CliError {
  return new CliError("PENDING_STATE_INVALID", message, {
    category: "conflict",
    humanDecision: true,
    hint: "Preserve the state file and inspect it; do not delete it or resend with a new key.",
    ...(details ? { details } : {}),
  });
}

/**
 * Validates a parsed state file exactly as the starter's `readState` does
 * (schemaVersion 1, status, idempotency key, createdAt, a valid body).
 * Throws `PENDING_STATE_INVALID` (exit 13).
 */
export function parsePendingState(value: unknown, file?: string): PendingState {
  const details = file ? { stateFile: file } : undefined;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    (value.status !== "pending" && value.status !== "completed") ||
    typeof value.idempotencyKey !== "string" ||
    !value.idempotencyKey ||
    typeof value.createdAt !== "string"
  ) {
    throw invalidState("Invalid pending state; preserve the file and inspect it before continuing.", details);
  }
  try {
    // A stored body is only read here; a resend checks it for secrets before sending.
    validateAction(value.body, { allowSecrets: true });
  } catch (error) {
    if (error instanceof CliError) {
      throw invalidState("Invalid pending state; preserve the file and inspect it before continuing.", {
        ...details,
        reason: error.message,
      });
    }
    throw error;
  }
  return value as unknown as PendingState;
}

/** Serializes a state exactly like the starter's `writeState`. */
export function serializePendingState(state: PendingState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * Reads a state file without following a symlink. Returns null when it does
 * not exist; throws `PENDING_STATE_INVALID` when it is malformed.
 */
export async function readPendingStateFile(file: string): Promise<PendingState | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const text = await handle.readFile("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalidState("Invalid pending state; preserve the file and inspect it before continuing.", {
        stateFile: file,
        reason: "not valid JSON",
      });
    }
    return parsePendingState(parsed, file);
  } catch (error) {
    if (error instanceof CliError) throw error;
    const code = errno(error);
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw invalidState("The state file is a symbolic link; refusing to read it.", { stateFile: file });
    if (code === "EISDIR" || code === "ENOTDIR") {
      throw new CliError("INVALID_PATH", `The state file path is not a file: ${file}.`, { humanDecision: false });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Where pending state lives: a file (normal) or process memory (`--demo`). */
export interface PendingStore {
  readonly kind: "file" | "memory";
  /** Absolute file path, or a label for a memory store. */
  readonly location: string;
  read(): Promise<PendingState | null>;
  write(state: PendingState): Promise<void>;
  /** Removes the state (no file afterwards); used only to undo a refused first send. */
  clear(): Promise<void>;
  /** Runs `fn` under the `O_EXCL` lock; a held lock is `STATE_LOCKED` (exit 13) at once, never waited on. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** True when the lock file exists (a running command, or a crashed one). */
  lockHeld(): Promise<boolean>;
}

/** The file-backed store for a state path (the starter's lock, read, and atomic write). */
export function createFilePendingStore(file: string): PendingStore {
  return {
    kind: "file",
    location: file,
    read: (): Promise<PendingState | null> => readPendingStateFile(file),
    write: (state: PendingState): Promise<void> => atomicWriteFile(file, serializePendingState(state), 0o600),
    async clear(): Promise<void> {
      try {
        await unlink(file);
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
      }
    },
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      try {
        const info = await stat(path.dirname(file));
        if (!info.isDirectory()) throw new Error("not a directory");
      } catch {
        throw new CliError("INVALID_PATH", `The state file directory does not exist: ${path.dirname(file)}.`, {
          humanDecision: false,
          hint: "Pass --state with a path in an existing directory.",
        });
      }
      return withFileLock(file, fn, { waitMs: 0 });
    },
    async lockHeld(): Promise<boolean> {
      try {
        await stat(`${file}.lock`);
        return true;
      } catch {
        return false;
      }
    },
  };
}

const memoryStates = new Map<string, { state: PendingState | null; locked: boolean }>();

/**
 * Process-memory store used by `--demo` (no files are ever written). Stores
 * with the same label share state for the life of the process.
 */
export function createMemoryPendingStore(label: string): PendingStore {
  const slot = memoryStates.get(label) ?? { state: null, locked: false };
  memoryStates.set(label, slot);
  return {
    kind: "memory",
    location: label,
    read: async (): Promise<PendingState | null> => (slot.state ? structuredClone(slot.state) : null),
    write: async (state: PendingState): Promise<void> => {
      slot.state = structuredClone(state);
    },
    clear: async (): Promise<void> => {
      slot.state = null;
    },
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      if (slot.locked) {
        throw new CliError("STATE_LOCKED", `State is locked by another command: ${label}.lock.`, { details: { lockFile: `${label}.lock` } });
      }
      slot.locked = true;
      try {
        return await fn();
      } finally {
        slot.locked = false;
      }
    },
    lockHeld: async (): Promise<boolean> => slot.locked,
  };
}

// ---------------------------------------------------------------------------
// Planning (shared by preview and execution)
// ---------------------------------------------------------------------------

/** What `--execute` would do with the current state. */
export type ExecutionPlan =
  | { kind: "new"; replacesCompleted: boolean }
  | { kind: "resend"; state: PendingState }
  | { kind: "already-completed"; state: PendingState };

/** `act`: submit one action (never resends pending work). `retry`: resend the pending action only. */
export type ExecutionMode = "act" | "retry";

export interface PlanOptions {
  newAction?: boolean;
  mode?: ExecutionMode;
  now: Date;
}

/** Age check against the 24-hour replay window (the starter's rule). */
export function pendingAgeMs(state: PendingState, now: Date): number {
  return now.getTime() - Date.parse(state.createdAt);
}

/** True when the pending action is still inside the 24-hour safe replay window. */
export function withinReplayWindow(state: PendingState, now: Date): boolean {
  const age = pendingAgeMs(state, now);
  return Number.isFinite(age) && age >= 0 && age < REPLAY_WINDOW_MS;
}

function mismatch(message: string, reason: string, extra: Json = {}, hint?: string): CliError {
  return new CliError("PENDING_ACTION_MISMATCH", message, {
    humanDecision: true,
    hint: hint ?? "Keep the state file. Resolve pending work with its original credentials, or use a separate --state file for another visitor.",
    details: { reason, ...extra },
  });
}

function validReceipt(state: PendingState): boolean {
  const data = isRecord(state.response) && isRecord(state.response.data) ? state.response.data : null;
  return data !== null && (CONFIRMED_STATUSES as readonly unknown[]).includes(data.status);
}

/**
 * Decides what executing would do, in the starter's order of checks, and
 * throws the error executing would throw. Pure: no I/O.
 *
 * - `--new-action` without a completed receipt: `NO_COMPLETED_ACTION` (2).
 * - State for another visitor, base, or key: `PENDING_ACTION_MISMATCH` (13).
 * - Pending older than 24 h: `PENDING_TOO_OLD` (9).
 * - Pending, act mode: a different body or `--new-action` is
 *   `PENDING_ACTION_MISMATCH` (13); the same body is `ACTION_PENDING` (9),
 *   because only `visitor pending --retry --execute` resends.
 * - Completed without `--new-action`: a different body is
 *   `PENDING_ACTION_MISMATCH` (13); the same body returns the receipt.
 */
export function planExecution(state: PendingState | null, identity: ActionIdentity, options: PlanOptions): ExecutionPlan {
  const mode = options.mode ?? "act";
  const newAction = mode === "act" && options.newAction === true;
  if (newAction && !state) {
    throw new CliError(
      "NO_COMPLETED_ACTION",
      "--new-action requires a completed receipt in this state file. Omit it for the first action; preserve existing state when retrying.",
      { category: "invalid_input", humanDecision: false },
    );
  }
  if (!state) {
    if (mode === "retry") {
      throw new CliError("NO_PENDING_ACTION", "There is no pending action in this state file; nothing was sent.", {
        category: "not_found",
        humanDecision: false,
      });
    }
    return { kind: "new", replacesCompleted: false };
  }
  const differing = (["agentId", "baseUrl", "keyFingerprint"] as const).filter((key) => state[key] !== identity[key]);
  if (differing.length > 0) {
    throw mismatch(
      "This state belongs to another visitor, API base, or API key. Use its original credentials to resolve pending work, or use a separate state file for another visitor.",
      "identity",
      { fields: differing, stateStatus: state.status },
    );
  }
  const matches = sameCanonical(state.body, identity.body);
  if (state.status === "pending") {
    if (!withinReplayWindow(state, options.now)) {
      throw new CliError(
        "PENDING_TOO_OLD",
        "Pending action is outside the 24-hour safe replay window. Do not resend or replace its key; inspect the journal and resolve the outcome with the operator.",
        {
          hint: "Run arcopolis visitor journal --json to look for its outcome, then ask the human. Keep the state file.",
          details: { createdAt: state.createdAt },
        },
      );
    }
    if (mode === "retry") return { kind: "resend", state };
    if (!matches || newAction) {
      throw mismatch(
        "A pending action must be resolved with the same body, visitor, API base, and API key. Keep the state file; --new-action cannot replace pending work.",
        newAction ? "new_action_on_pending" : "pending_body",
        { stateStatus: "pending" },
        "Run arcopolis visitor pending --json and ask the human. Never resend with a new key.",
      );
    }
    throw new CliError(
      "ACTION_PENDING",
      "This exact action is already pending from an earlier attempt, and its outcome is unknown. Nothing was sent.",
      {
        category: "unresolved_write",
        hint: "Run arcopolis visitor pending --json and report to the human. Resend only with arcopolis visitor pending --retry --execute, which reuses the same key.",
        details: { createdAt: state.createdAt },
      },
    );
  }
  if (mode === "retry" || !newAction) {
    if (mode === "act" && !matches) {
      throw mismatch(
        "The previous action completed. Use --new-action explicitly to submit a different action.",
        "completed_receipt",
        { stateStatus: "completed" },
        "Add --new-action only when the human asked for another action; it replaces the completed receipt.",
      );
    }
    if (!validReceipt(state)) throw invalidState("Completed receipt is invalid; preserve and inspect the state file.");
    return { kind: "already-completed", state };
  }
  return { kind: "new", replacesCompleted: true };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ExecuteActionInput {
  /** Data-plane client carrying the visitor key. */
  client: HttpClient;
  /** The key the client sends (only its sha256 fingerprint is stored). */
  apiKey: string;
  /** Normalized data base (`https://api.arcopolis.ai/v1`), stored as `baseUrl`. */
  baseUrl: string;
  agentId: string;
  /** The action; ignored in retry mode (the pending body is resent). */
  body?: unknown;
  store: PendingStore;
  newAction?: boolean;
  mode?: ExecutionMode;
  now?: () => Date;
  effects?: Effects;
  /** Called with each confirmed heartbeat (the CLI updates its cache). */
  onHeartbeat?: (response: ApiResponse<HeartbeatData>) => Promise<void> | void;
}

export interface ExecuteActionResult {
  state: "completed" | "already-completed";
  /** The full act response envelope `{data: …}`. */
  result: Record<string, unknown>;
  /** The final state (as written, or as found). */
  pending: PendingState;
  heartbeat: ApiResponse<HeartbeatData> | null;
  /** True when a pending action was resent with its saved key. */
  resent: boolean;
}

function recordActOutcome(effects: Effects | undefined, status: unknown): void {
  if (!effects) return;
  if (status === "created") {
    effects.write("public_content");
    effects.spend("drive", 1);
  } else if (status === "skipped") {
    effects.spend("drive", 1);
  } else {
    effects.spend("drive", "unknown");
  }
}

/** Categories that never prove an action had no effect. */
const UNCERTAIN_CATEGORIES: ReadonlySet<string> = new Set(["unresolved_write", "conflict", "transient", "edge_blocked", "internal"]);

/**
 * True for an `/act` failure that proves a **first** send had no effect: an
 * HTTP 4xx other than 408, 409, and 425, carrying an API error code outside
 * the unresolved, conflict, transient, edge, and internal categories (for
 * example `INPUT_MODERATION_BLOCKED`, `INVALID_ACTION`,
 * `DRIVE_DAILY_BUDGET_EXCEEDED`). It proves nothing for a resend: the resend
 * can be refused (moderation is not deterministic) even when the first
 * attempt took effect, so a resend's state always stays pending.
 */
export function isDefinitiveRefusal(error: unknown): boolean {
  if (!(error instanceof CliError)) return false;
  const status = error.httpStatus;
  if (status === null || status < 400 || status >= 500 || status === 408 || status === 409 || status === 425) return false;
  return !UNCERTAIN_CATEGORIES.has(error.category);
}

/** Maps a non-JSON or envelope-less `/act` reply to `INVALID_ACTION_RESPONSE` (exit 9). */
function actFailure(error: unknown): unknown {
  if (error instanceof CliError && (error.code === "NON_JSON_RESPONSE" || error.code === "INVALID_RESPONSE")) {
    return new CliError(
      "INVALID_ACTION_RESPONSE",
      "The action response was not a confirmed created/skipped/blocked result. Pending state was preserved.",
      { httpStatus: error.httpStatus, surface: error.surface, details: error.details, cause: error },
    );
  }
  return error;
}

/**
 * `POST /v1/visitors/{id}/act` with the saved body and idempotency key, and
 * the starter's response check. Records the content write and drive spend
 * (`public_content?` and `drive: "unknown"` when the outcome is uncertain).
 */
export async function postAction(client: HttpClient, state: PendingState, effects?: Effects, resend = false): Promise<ApiResponse<Json>> {
  let response: ApiResponse<Json>;
  try {
    response = await client.post<Json>(visitorPath(state.agentId, "act"), state.body, {
      idempotencyKey: state.idempotencyKey,
      purpose: "act",
    });
  } catch (error) {
    const mapped = actFailure(error);
    if (outcomeUncertain(mapped)) {
      effects?.write("public_content?");
      effects?.spend("drive", "unknown");
    }
    throw mapped;
  }
  const data = isRecord(response.body.data) ? response.body.data : null;
  const kind: ActionKind = actionKindOf(state.body);
  if (
    data?.agentId !== state.agentId ||
    data.action !== kind ||
    !(CONFIRMED_STATUSES as readonly unknown[]).includes(data.status)
  ) {
    effects?.write("public_content?");
    effects?.spend("drive", "unknown");
    throw new CliError(
      "INVALID_ACTION_RESPONSE",
      "The action response was not a confirmed created/skipped/blocked result. Pending state was preserved.",
      { httpStatus: response.status, surface: "data" },
    );
  }
  if (resend) {
    if (data.status === "created") effects?.write("public_content");
    effects?.spend("drive", "unknown");
  } else {
    recordActOutcome(effects, data.status);
  }
  return response;
}

/**
 * Persists the exact request identity before sending and retains uncertain
 * outcomes for replay (the starter's `executeAction`):
 *
 * 1. Validate the body, then take the `O_EXCL` lock.
 * 2. Plan against the current state ({@link planExecution}).
 * 3. For a new action: a fresh heartbeat, the visitor and menu checks, then
 *    the pending state is written (0600, atomic) with a new
 *    `action-<uuid>` key **before** `POST /act`.
 * 4. `POST /act`; only a confirmed created/skipped/blocked response for this
 *    visitor and action completes the state. A definitive refusal of this
 *    first send restores the previous state; every other failure keeps it
 *    pending.
 */
export async function executeAction(input: ExecuteActionInput): Promise<ExecuteActionResult> {
  const mode = input.mode ?? "act";
  const now = input.now ?? ((): Date => new Date());
  if (mode === "act") validateAction(input.body);
  return input.store.withLock(async (): Promise<ExecuteActionResult> => {
    const fingerprint = keyFingerprint(input.apiKey);
    const state = await input.store.read();
    const body = (mode === "retry" && state ? state.body : input.body) as ActionBody;
    const identity: ActionIdentity = { body, agentId: input.agentId, baseUrl: input.baseUrl, keyFingerprint: fingerprint };
    const plan = planExecution(state, identity, { newAction: input.newAction, mode, now: now() });
    if (plan.kind === "already-completed") {
      return {
        state: "already-completed",
        result: plan.state.response ?? {},
        pending: plan.state,
        heartbeat: null,
        resent: false,
      };
    }
    let pending: PendingState;
    let heartbeat: ApiResponse<HeartbeatData> | null = null;
    if (plan.kind === "new") {
      heartbeat = await sendHeartbeat(input.client, input.agentId, input.effects);
      assertHeartbeatVisitor(heartbeat.body, input.agentId);
      await input.onHeartbeat?.(heartbeat);
      assertMenuAllows(heartbeat.body, body);
      pending = {
        schemaVersion: 1,
        status: "pending",
        ...identity,
        idempotencyKey: `action-${randomUUID()}`,
        createdAt: now().toISOString(),
      };
      await input.store.write(pending);
    } else {
      // Never resend a stored body that would publish a key (a starter file is not checked when written).
      assertNoSecretsInAction(plan.state.body);
      pending = plan.state;
    }
    let response: ApiResponse<Json>;
    try {
      response = await postAction(input.client, pending, input.effects, plan.kind === "resend");
    } catch (error) {
      // A definitive refusal of a first send took no effect: restore what the file held before.
      if (plan.kind === "new" && isDefinitiveRefusal(error)) {
        if (state) await input.store.write(state);
        else await input.store.clear();
      }
      throw error;
    }
    const completed: PendingState = {
      ...pending,
      status: "completed",
      response: response.body,
      completedAt: now().toISOString(),
    };
    await input.store.write(completed);
    return { state: "completed", result: response.body, pending: completed, heartbeat, resent: plan.kind === "resend" };
  });
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

/** A redaction-safe summary of the state file for `visitor pending` and `status`. */
export interface PendingSummary {
  status: "pending" | "completed";
  action: ActionKind;
  body: ActionBody;
  agentId: string;
  baseUrl: string;
  /** First 12 hex characters of the key fingerprint. */
  keyFingerprintPrefix: string;
  idempotencyKey: string;
  createdAt: string;
  ageSeconds: number | null;
  replayWindowEndsAt: string | null;
  withinReplayWindow: boolean;
  completedAt?: string;
  outcome?: string;
  skipReason?: string;
  result?: Json;
}

/** Summarizes a state for output (the key fingerprint is shortened). */
export function describePending(state: PendingState, now: Date): PendingSummary {
  const created = Date.parse(state.createdAt);
  const summary: PendingSummary = {
    status: state.status,
    action: actionKindOf(state.body),
    body: state.body,
    agentId: state.agentId,
    baseUrl: state.baseUrl,
    keyFingerprintPrefix: typeof state.keyFingerprint === "string" ? state.keyFingerprint.slice(0, 12) : "",
    idempotencyKey: state.idempotencyKey,
    createdAt: state.createdAt,
    ageSeconds: Number.isFinite(created) ? Math.round((now.getTime() - created) / 1000) : null,
    replayWindowEndsAt: Number.isFinite(created) ? new Date(created + REPLAY_WINDOW_MS).toISOString() : null,
    withinReplayWindow: state.status === "pending" && withinReplayWindow(state, now),
  };
  if (state.completedAt) summary.completedAt = state.completedAt;
  const data = isRecord(state.response) && isRecord(state.response.data) ? state.response.data : null;
  if (data) {
    if (typeof data.status === "string") summary.outcome = data.status;
    if (typeof data.skipReason === "string") summary.skipReason = data.skipReason;
    summary.result = data;
  }
  return summary;
}
