/**
 * Stable error model for the Arcopolis CLI (plan §3.1 and §3.2).
 *
 * Every failure a command reports is a {@link CliError}. Its `code` is either
 * the server's `error.code` or a local code, its `category` mirrors the exit
 * code, and agents branch on `code` and the exit code, never on message text.
 */

/** One category per stable exit code (plan §3.2). */
export type ErrorCategory =
  | "internal"
  | "invalid_input"
  | "auth"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "budget_exhausted"
  | "unavailable"
  | "unresolved_write"
  | "needs_human"
  | "edge_blocked"
  | "transient"
  | "conflict";

/** Where a failure came from: this process, the developer control plane, the data plane, or the CDN edge. */
export type ErrorSurface = "local" | "control" | "data" | "edge";

export type RetryStrategy =
  | "none"
  | "after_seconds"
  | "after_utc_reset"
  | "same_request_only"
  | "after_human"
  | "later";

export interface RetryInfo {
  strategy: RetryStrategy;
  /** Present with `after_seconds`. */
  afterSeconds?: number;
  /** ISO-8601 UTC; present with `after_utc_reset`. */
  resetsAt?: string;
}

/** Exit code for each category. `ok` is 0. */
export const EXIT_CODES = {
  ok: 0,
  internal: 1,
  invalid_input: 2,
  auth: 3,
  forbidden: 4,
  not_found: 5,
  rate_limited: 6,
  budget_exhausted: 7,
  unavailable: 8,
  unresolved_write: 9,
  needs_human: 10,
  edge_blocked: 11,
  transient: 12,
  conflict: 13,
} as const satisfies Record<ErrorCategory | "ok", number>;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** One row of the published exit-code table (`arcopolis schema`). */
export interface ExitCodeRow {
  exit: number;
  category: ErrorCategory | "ok";
  codes: string[];
  action: string;
}

/**
 * Explicit code -> category table. Entries ending in `*` are prefix patterns,
 * entries starting with `*` are suffix patterns. Exact entries win over
 * patterns; see {@link lookupCodeCategory}.
 */
const CATEGORY_CODES: Record<ErrorCategory, readonly string[]> = {
  internal: ["INTERNAL", "NOT_IMPLEMENTED", "GRANT_PAYLOAD_INVALID", "DEMO_WRITE_BLOCKED", "SPAWN_FAILED"],
  invalid_input: [
    // local usage
    "USAGE_ERROR",
    "UNKNOWN_COMMAND",
    "UNKNOWN_FLAG",
    "INVALID_FLAG_VALUE",
    "MISSING_ARGUMENT",
    "INVALID_BASE",
    "CUSTOM_BASE_NOT_ALLOWED",
    "INVALID_KEY_FORMAT",
    "INVALID_PATH",
    "ENV_FILE_TRACKED",
    "ENV_FILE_NOT_IGNORED",
    "SECRET_IN_ARGUMENTS",
    "SECRET_IN_ACTION",
    "STORE_NOT_IGNORED",
    "STORE_PATH_SYMLINK",
    "GITIGNORE_SYMLINK",
    "PATH_NOT_IN_OPENAPI",
    "VISITOR_PATH_REFUSED",
    "COMMAND_NOT_FOUND",
    "COMMAND_NOT_EXECUTABLE",
    "NO_COMPLETED_ACTION",
    // server
    "INVALID_INPUT",
    "INVALID_QUERY",
    "INVALID_ACTION",
    "IDEMPOTENCY_KEY_REQUIRED",
    "PAYLOAD_TOO_LARGE",
    "INPUT_MODERATION_BLOCKED",
    "INVALID_JOURNAL_QUERY",
    "JOURNAL_CURSOR_SCOPE_MISMATCH",
    "INVALID_STANDING_QUERY",
    "INVALID_OBSERVE_*",
    "CLI_GRANT_CODE_MATCH_REQUIRED",
    "METHOD_NOT_ALLOWED",
  ],
  auth: [
    "MISSING_API_KEY",
    "INVALID_API_KEY",
    "KEY_REVOKED",
    "KEY_DISABLED",
    "APP_DISABLED",
    "UNAUTHORIZED",
    "NO_CREDENTIALS",
    "INSECURE_CREDENTIAL_FILE",
    "CREDENTIALS_FILE_INVALID",
    "STORED_KEY_ORIGIN_MISMATCH",
  ],
  forbidden: [
    "INSUFFICIENT_TIER",
    "INSUFFICIENT_SCOPE",
    "DRIVE_BINDING_INVALID",
    "DRIVE_WORLD_MISMATCH",
    "DRIVE_AGENT_NOT_ALLOWED",
    "DRIVE_AGENT_NOT_VISITOR",
    "DRIVE_AGENT_DISABLED",
    "AGENT_NOT_ALLOWED",
    "INVOKE_AGENT_NOT_CONFIGURED",
    "STANDING_ACCESS_DENIED",
    "OBSERVE_ACCESS_DENIED",
    "ACCOUNT_PENDING",
    "ACCOUNT_DISABLED",
    "ACCOUNT_NOT_ACTIVE",
    "ANONYMOUS_SIGNUP_NOT_ALLOWED",
    "ADMIN_ACCESS_OPERATOR_MANAGED",
    "APP_REVOKED",
    "APP_SUSPENDED",
    "HUMAN_SESSION_REQUIRED",
    "EMAIL_VERIFICATION_REQUIRED",
    "PASSPORT_HUMAN_REQUIRED",
    "CLI_GRANTS_NOT_ALLOWED",
    "CLI_GRANT_ACCOUNT_MISMATCH",
    "APPROVER_MISMATCH",
    "WRITES_DISABLED",
    "STORE_NOT_WRITABLE",
    "INIT_WRITE_FAILED",
  ],
  not_found: [
    "NOT_FOUND",
    "WORLD_NOT_FOUND",
    "APP_NOT_FOUND",
    "VISITOR_NOT_FOUND",
    "CLI_GRANT_NOT_FOUND",
    "GRANT_NOT_STARTED",
    "NO_PENDING_ACTION",
  ],
  rate_limited: [
    "RATE_LIMIT_EXCEEDED",
    "OBSERVE_RATE_LIMITED",
    "SLOW_DOWN",
    "CLI_GRANT_RATE_LIMITED",
    "LOCAL_RATE_LIMIT",
    "LOCAL_CADENCE_GUARD",
  ],
  budget_exhausted: ["*_DAILY_BUDGET_EXCEEDED", "ACTION_BUDGET_EMPTY"],
  unavailable: [
    "VISITOR_DRIVE_DISABLED",
    "VISITOR_JOURNAL_DISABLED",
    "VISITOR_STANDING_DISABLED",
    "VISITOR_OBSERVE_DISABLED",
    "AGENT_INVOKE_DISABLED",
    "DEVELOPER_PORTAL_DISABLED",
    "CLI_GRANTS_DISABLED",
    "VISITOR_SELF_SERVE_DISABLED",
    "VISITORS_PAUSED",
    "DEVELOPER_SIGNUPS_DISABLED",
    "NO_VISITOR_WORLD_OPEN",
    "ACTION_CLOSED",
  ],
  unresolved_write: [
    "VISITOR_ACTION_OUTCOME_UNRESOLVED",
    "WRITE_TIMEOUT",
    "WRITE_NETWORK_ERROR",
    "INVALID_ACTION_RESPONSE",
    "PENDING_TOO_OLD",
    "ACTION_PENDING",
  ],
  needs_human: [
    "APPROVAL_PENDING",
    "APPROVAL_DENIED",
    "CONFIRMATION_REQUIRED",
    "CONFIRMATION_DECLINED",
    "HUMAN_SETUP_REQUIRED",
    "PREVIEW_DIGEST_MISMATCH",
    "INPUT_REQUIRED",
    "PROMPT_TIMEOUT",
    "DEVELOPER_TERMS_ACCEPTANCE_REQUIRED",
    "VISITOR_TERMS_ACCEPTANCE_REQUIRED",
  ],
  edge_blocked: ["EDGE_BLOCKED", "NON_JSON_RESPONSE", "REDIRECT_REJECTED", "INVALID_RESPONSE", "INVALID_HEARTBEAT_RESPONSE"],
  transient: [
    "INTERNAL_ERROR",
    "TIMEOUT",
    "NETWORK_ERROR",
    "*_READ_FAILED",
    "*_UNAVAILABLE",
    "*_BUDGET_CHECK_FAILED",
    "LLM_*",
  ],
  conflict: [
    "CLI_GRANT_NOT_PENDING",
    "CLI_GRANT_EXPIRED",
    "CLI_GRANT_REQUEST_CHANGED",
    "VISITOR_LIMIT_REACHED",
    "VISITOR_REGISTRATION_REFUSED",
    "VISITOR_WORLD_REQUIRED",
    "APP_LOCKED",
    "STATE_LOCKED",
    "PENDING_ACTION_MISMATCH",
    "PENDING_STATE_INVALID",
    "STATE_FILE_CONFLICT",
    "GRANT_BASE_MISMATCH",
  ],
};

/** What an agent should do for each exit code (published by `arcopolis schema`). */
const EXIT_ACTIONS: Record<ErrorCategory | "ok", string> = {
  ok: "continue",
  internal: "report it; do not loop",
  invalid_input: "fix the input; changed text is a new action",
  auth: "arcopolis setup, or ask the human",
  forbidden: "stop; tell the human",
  not_found: "check ids",
  rate_limited: "wait retry.afterSeconds, then retry once",
  budget_exhausted: "stop until retry.resetsAt (UTC day rollover, 7:00 PM CDT / 6:00 PM CST)",
  unavailable: "a service switch; tell the human; do not loop",
  unresolved_write: "never resend with a new key; visitor pending, then ask the human",
  needs_human: "show humanAction to the human; add confirmation flags only when the human asked",
  edge_blocked: "report status and content type",
  transient: "retry later",
  conflict: "resolve the state; setup --new for an expired grant",
};

const exactCodes = new Map<string, ErrorCategory>();
const prefixCodes: Array<[string, ErrorCategory]> = [];
const suffixCodes: Array<[string, ErrorCategory]> = [];
for (const [category, codes] of Object.entries(CATEGORY_CODES) as Array<[ErrorCategory, readonly string[]]>) {
  for (const code of codes) {
    if (code.endsWith("*")) prefixCodes.push([code.slice(0, -1), category]);
    else if (code.startsWith("*")) suffixCodes.push([code.slice(1), category]);
    else exactCodes.set(code, category);
  }
}

/**
 * Category from the explicit table only (exact code, then prefix, then
 * suffix pattern). Returns `undefined` for an unknown code.
 */
export function lookupCodeCategory(code: string): ErrorCategory | undefined {
  const exact = exactCodes.get(code);
  if (exact) return exact;
  for (const [prefix, category] of prefixCodes) if (code.startsWith(prefix)) return category;
  for (const [suffix, category] of suffixCodes) if (code.endsWith(suffix)) return category;
  return undefined;
}

/** True when the code is covered by the explicit table (not only by the HTTP-status fallback). */
export function isKnownCode(code: string): boolean {
  return lookupCodeCategory(code) !== undefined;
}

/** Fallback category for an unknown code, from its HTTP status (plan §3.2). */
export function categoryForStatus(httpStatus: number | null | undefined, write = false): ErrorCategory {
  if (httpStatus === undefined || httpStatus === null || httpStatus === 0) return "internal";
  if (httpStatus >= 500) return "transient";
  if (httpStatus >= 300 && httpStatus < 400) return "edge_blocked";
  switch (httpStatus) {
    case 400:
    case 413:
    case 422:
      return "invalid_input";
    case 401:
      return "auth";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return write ? "unresolved_write" : "conflict";
    case 410:
      return "conflict";
    case 429:
      return "rate_limited";
    default:
      return httpStatus >= 400 ? "invalid_input" : "internal";
  }
}

/**
 * Category for a code: the explicit table first, then the HTTP-status
 * fallback. `IDEMPOTENCY_IN_PROGRESS` is `unresolved_write` on a write and
 * `conflict` otherwise.
 */
export function categoryForCode(
  code: string,
  options: { httpStatus?: number | null; write?: boolean } = {},
): ErrorCategory {
  if (code === "IDEMPOTENCY_IN_PROGRESS") return options.write ? "unresolved_write" : "conflict";
  return lookupCodeCategory(code) ?? categoryForStatus(options.httpStatus, options.write ?? false);
}

/** Exit code for a category. */
export function exitCodeFor(category: ErrorCategory | "ok"): number {
  return EXIT_CODES[category];
}

/** The full exit-code table, one row per exit code, for `arcopolis schema`. */
export function exitCodeTable(): ExitCodeRow[] {
  const rows: ExitCodeRow[] = [{ exit: 0, category: "ok", codes: [], action: EXIT_ACTIONS.ok }];
  for (const [category, codes] of Object.entries(CATEGORY_CODES) as Array<[ErrorCategory, readonly string[]]>) {
    const listed = [...codes];
    if (category === "unresolved_write") listed.unshift("IDEMPOTENCY_IN_PROGRESS (on a write)");
    if (category === "transient") listed.push("HTTP 5xx");
    rows.push({ exit: EXIT_CODES[category], category, codes: listed, action: EXIT_ACTIONS[category] });
  }
  return rows.sort((a, b) => a.exit - b.exit);
}

/** The next 00:00:00.000 UTC strictly after `now`, as ISO-8601 (the daily budget reset). */
export function nextUtcMidnight(now: Date): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.toISOString();
}

/** Default retry advice for a category (plan §3.1 `retry.strategy`). */
export function defaultRetry(
  category: ErrorCategory,
  options: { retryAfterSeconds?: number | null; now?: Date } = {},
): RetryInfo {
  const after = options.retryAfterSeconds;
  switch (category) {
    case "rate_limited":
      return typeof after === "number" ? { strategy: "after_seconds", afterSeconds: after } : { strategy: "later" };
    case "budget_exhausted":
      return { strategy: "after_utc_reset", resetsAt: nextUtcMidnight(options.now ?? new Date()) };
    case "unresolved_write":
      return { strategy: "same_request_only" };
    case "auth":
    case "forbidden":
    case "unavailable":
    case "needs_human":
      return { strategy: "after_human" };
    case "transient":
      return typeof after === "number" ? { strategy: "after_seconds", afterSeconds: after } : { strategy: "later" };
    default:
      return { strategy: "none" };
  }
}

const HUMAN_DECISION_CATEGORIES = new Set<ErrorCategory>([
  "auth",
  "forbidden",
  "unavailable",
  "unresolved_write",
  "needs_human",
]);

/** Options for {@link CliError}. Everything is optional; defaults come from the code table. */
export interface CliErrorOptions {
  /** Overrides the table. Use it for a new local code that is not in the table yet. */
  category?: ErrorCategory;
  httpStatus?: number | null;
  surface?: ErrorSurface;
  retry?: RetryInfo;
  /** Seconds from `Retry-After`, used to build the default retry advice. */
  retryAfterSeconds?: number | null;
  humanDecision?: boolean;
  hint?: string;
  details?: Record<string, unknown>;
  /** Treat a 409 fallback as a write (exit 9) instead of a conflict (exit 13). */
  write?: boolean;
  /** Top-level `humanAction` block of the error document (setup, confirmations). */
  humanAction?: Record<string, unknown>;
  /** Top-level `data` of the error document (for example a write preview). */
  data?: unknown;
  /** `next` steps of the error document. */
  next?: Array<{ command: string; why: string; humanDecision: boolean }>;
  now?: Date;
  cause?: unknown;
}

/**
 * The one error type every command throws. `bin.ts` turns it into the error
 * document and exit code; nothing else prints errors.
 */
export class CliError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly exitCode: number;
  readonly httpStatus: number | null;
  readonly surface: ErrorSurface;
  readonly retry: RetryInfo;
  readonly humanDecision: boolean;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  readonly humanAction: Record<string, unknown> | undefined;
  readonly data: unknown;
  readonly next: Array<{ command: string; why: string; humanDecision: boolean }>;

  constructor(code: string, message: string, options: CliErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CliError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? null;
    this.category =
      options.category ?? categoryForCode(code, { httpStatus: this.httpStatus, write: options.write ?? false });
    this.exitCode = EXIT_CODES[this.category];
    this.surface = options.surface ?? "local";
    this.retry =
      options.retry ?? defaultRetry(this.category, { retryAfterSeconds: options.retryAfterSeconds, now: options.now });
    this.humanDecision = options.humanDecision ?? HUMAN_DECISION_CATEGORIES.has(this.category);
    this.hint = options.hint;
    this.details = options.details;
    this.humanAction = options.humanAction;
    this.data = options.data;
    this.next = options.next ?? [];
  }
}

/** Shorthand for the stub commands Phase 1 feature work replaces. */
export function notImplemented(command: string): CliError {
  return new CliError("NOT_IMPLEMENTED", `arcopolis ${command} is not implemented yet.`, {
    hint: "Run arcopolis schema --json to see which commands are available.",
  });
}

/** Input to {@link fromApiError}: one parsed non-2xx API response. */
export interface ApiErrorInput {
  httpStatus: number;
  /** `error.code` from the body, or undefined when the body had none. */
  code?: string | null;
  message?: string | null;
  /** The rest of the server's `error` object (reasonCode, candidates, invocationId, ...). */
  extra?: Record<string, unknown>;
  surface: ErrorSurface;
  write?: boolean;
  retryAfterSeconds?: number | null;
  now?: Date;
}

/**
 * Maps a server error envelope to a {@link CliError}. Server `reasonCode`,
 * `candidates`, and `invocationId` pass through under `details`. A
 * `VISITOR_WORLD_REQUIRED` with empty candidates is re-coded as
 * `NO_VISITOR_WORLD_OPEN` (exit 8).
 */
export function fromApiError(input: ApiErrorInput): CliError {
  const extra = input.extra ?? {};
  let code = input.code && /^[A-Z][A-Z0-9_]*$/.test(input.code) ? input.code : `HTTP_${input.httpStatus}`;
  const candidates = extra.candidates;
  let message = input.message?.trim() || `API request failed with HTTP ${input.httpStatus}.`;
  if (code === "VISITOR_WORLD_REQUIRED" && (!Array.isArray(candidates) || candidates.length === 0)) {
    code = "NO_VISITOR_WORLD_OPEN";
    message = "No visitor world is open right now.";
  }
  const details: Record<string, unknown> = {
    reasonCode: extra.reasonCode ?? null,
    candidates: candidates ?? null,
    invocationId: extra.invocationId ?? null,
  };
  for (const [key, value] of Object.entries(extra)) {
    if (!(key in details)) details[key] = value;
  }
  return new CliError(code, message, {
    httpStatus: input.httpStatus,
    surface: input.surface,
    write: input.write ?? false,
    retryAfterSeconds: input.retryAfterSeconds ?? null,
    details,
    now: input.now,
  });
}

/** The `error` object of the error document (plan §3.1). */
export interface ErrorBody {
  category: ErrorCategory;
  code: string;
  message: string;
  httpStatus: number | null;
  surface: ErrorSurface;
  retry: RetryInfo;
  humanDecision: boolean;
  hint?: string;
  details?: Record<string, unknown>;
}

/** Serializable `error` object for a {@link CliError}. */
export function toErrorBody(error: CliError): ErrorBody {
  const body: ErrorBody = {
    category: error.category,
    code: error.code,
    message: error.message,
    httpStatus: error.httpStatus,
    surface: error.surface,
    retry: error.retry,
    humanDecision: error.humanDecision,
  };
  if (error.hint) body.hint = error.hint;
  if (error.details) body.details = error.details;
  return body;
}
