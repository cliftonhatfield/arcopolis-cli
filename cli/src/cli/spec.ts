/**
 * Command contract shared by every command module (plan §4.9). A command is a
 * declarative {@link CommandSpec}: the same object drives argument parsing,
 * `--help`, `arcopolis schema`, and execution.
 *
 * Command modules import from here (never from `registry.ts`, which imports
 * the command modules) and export `commands: CommandSpec[]`.
 */
import type { ResolvedBase } from "../core/bases.js";
import type {
  ConfigFile,
  CredentialStore,
  CredentialsFile,
  EffectiveWritePolicy,
  Env,
  ResolvedCredentials,
  ResolvedKey,
  StorePaths,
} from "../core/credentials.js";
import { CliError } from "../core/errors.js";
import type { FetchLike, HttpClient } from "../core/http.js";
import type { WriteAuthorization } from "../core/interactive.js";
import type { CommandResult, Effects, Warnings } from "../core/output.js";
import type { LoadedProject } from "../core/project.js";
import type { Writer } from "../core/redact.js";

export type { CommandResult, DocumentResult, PassthroughResult, NextStep } from "../core/output.js";

/** JSON Schema object (draft 2020-12 subset); kept loose on purpose. */
export type JsonSchema = Record<string, unknown>;

export type FlagType = "boolean" | "string" | "integer" | "number";

/** One flag, named without leading dashes (`per-page`, `no-verify`). */
export interface FlagSpec {
  name: string;
  type: FlagType;
  description: string;
  short?: string;
  multiple?: boolean;
  /** Allowed values for a string flag. */
  enum?: readonly string[];
  /** Inclusive bounds for integer/number flags. */
  min?: number;
  max?: number;
  /** Maximum trimmed length for a string flag. */
  maxLength?: number;
  /** Setting this flag is a decision the human must make (e.g. `--execute`). */
  humanDecision?: boolean;
  /** Help placeholder (`PATH`, `SECONDS`). */
  placeholder?: string;
  default?: string | number | boolean;
}

export interface PositionalSpec {
  name: string;
  description: string;
  required?: boolean;
  /** Collects every remaining positional (only the last one). */
  variadic?: boolean;
}

/** Which credential a command needs. */
export type CredentialNeed = "none" | "read" | "visitor" | "stored";

/** How a command is authorized. */
export type ConfirmationKind = "none" | "execute" | "yes" | "human_approval";

export interface CommandEffectsSpec {
  /** Write kinds, e.g. `presence`, `public_content`, `credential_store`, `project_files`, `cli_grant`. */
  writes: string[];
  /** Spend kinds, e.g. `rateLimit`, `heartbeat`, `drive`, `journal`, `standing`. */
  spends: string[];
}

/** A command definition. `name` is the full space-separated path (`visitor act`). */
export interface CommandSpec {
  name: string;
  summary: string;
  description?: string;
  phase: 1 | 2 | 3;
  credentials: CredentialNeed;
  confirmation: ConfirmationKind;
  /** Plain-language network behavior, e.g. `none`, `data (1 per page)`, `data (only with --execute)`. */
  network: string;
  effects: CommandEffectsSpec;
  flags: FlagSpec[];
  positionals: PositionalSpec[];
  /** Codes this command can report (documentation; not enforced). */
  errors: string[];
  exitCodes: number[];
  outputSchema: JsonSchema;
  /**
   * Name of the flag that overrides the visitor agent id (usually `agent`).
   * Only this flag feeds agent-id resolution (`--agent` → env → project → profile).
   */
  agentIdFlag?: string;
  /** `passthrough` commands (exec, mcp) write their own stdout and print no document on success. */
  output?: "document" | "passthrough";
  examples?: string[];
  run(ctx: CommandContext): Promise<CommandResult>;
  /** Human-mode rendering of a successful document result (stdout). Defaults to pretty JSON. */
  renderHuman?(result: DocumentView, ctx: CommandContext): string;
}

/** What `renderHuman` receives: the success document fields. */
export interface DocumentView {
  data: unknown;
  meta: Record<string, unknown>;
  next: Array<{ command: string; why: string; humanDecision: boolean }>;
  warnings: Array<{ code: string; message: string }>;
}

export type FlagValue = string | boolean | number | string[] | number[] | undefined;

/** Output and interaction mode of this invocation. */
export interface CommandMode {
  /** Print one JSON document on stdout. */
  json: boolean;
  /** False when stdin/stdout is not a TTY, `--no-input`, `ARCOPOLIS_NO_INPUT=1`, `CI`, or an agent marker. */
  interactive: boolean;
  nonInteractiveReasons: string[];
  demo: boolean;
  verbose: boolean;
  quiet: boolean;
  /** `--timeout` in milliseconds, or null for per-request defaults. */
  timeoutMs: number | null;
  /** True only inside `arcopolis mcp` (adds ` mcp` to the User-Agent). */
  mcp: boolean;
}

/** Streams. `stdout`/`stderr` redact every write. */
export interface CommandIO {
  /** Redacting stdout. In document mode `bin.ts` owns stdout; commands use it only when they stream human text. */
  stdout: Writer;
  /** Redacting stderr. */
  stderr: Writer;
  /** Progress line on stderr (suppressed by `--quiet`). */
  progress(message: string): void;
  /** Redacted trace on stderr, only with `--verbose`. */
  trace(message: string): void;
  /** Unredacted process streams for passthrough commands (MCP JSON-RPC, `exec --raw-output`). */
  rawStdout: NodeJS.WritableStream;
  rawStderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}

/** Lazily loaded, cached accessors for local state. */
export interface StoreAccess {
  readonly paths: StorePaths;
  readonly credentialStore: CredentialStore;
  /** Raw `credentials.json` (secure read; empty store when absent). */
  credentials(): Promise<CredentialsFile>;
  /** `config.json` with defaults (writePolicy, installId, defaultProfile). */
  config(): Promise<ConfigFile>;
  /**
   * The `writePolicy` in force: the most restrictive of this store's
   * `config.json` and the platform-default user `config.json`, so relocating
   * the store never lowers it. Use this, never `config().writePolicy`.
   */
  writePolicy(): Promise<EffectiveWritePolicy>;
  /** Untrusted `arcopolis.json` (only allowed fields; warnings already recorded). */
  project(): Promise<LoadedProject>;
  /** Plan §5 resolution with sources (profile, read key, visitor key, agent id). */
  resolved(): Promise<ResolvedCredentials>;
  /**
   * Drops the cached credentials, config, and resolution so the next read
   * sees a write made earlier in this invocation (for example a key that
   * `auth import` or `setup` just stored and now verifies).
   */
  invalidate(): void;
  /** Data-plane base (`ARCOPOLIS_API_BASE` → legacy → default; canonical in demo). */
  apiBase(): ResolvedBase;
  /** Control-plane base (`ARCOPOLIS_DEVELOPER_BASE` → default; canonical in demo). */
  developerBase(): ResolvedBase;
}

export interface DataClientOptions {
  /** Overrides the resolved agent id (visitor clients). */
  agentId?: string;
  /** Per-client timeout override in ms (else `--timeout`, else per-purpose defaults). */
  timeoutMs?: number;
}

/** A data-plane client bound to one resolved key. */
export interface DataClient {
  client: HttpClient;
  key: ResolvedKey;
  base: ResolvedBase;
  /** Visitor clients: the agent id (never null for `visitor`). Read clients: the resolved id if any. */
  agentId: string | null;
  demo: boolean;
}

/** Write authorization request (see `authorizeLiveWrite` in core/interactive.ts). */
export interface AuthorizeWriteInput {
  previewMessage: string;
  previewData?: unknown;
  question: string;
}

/** Registry view available to commands (for `schema` and help). */
export interface RegistryView {
  readonly commands: readonly CommandSpec[];
  find(name: string): CommandSpec | undefined;
  /** The full `arcopolis schema` document. */
  schemaDocument(): Record<string, unknown>;
  /** One command's schema entry. */
  describe(spec: CommandSpec): Record<string, unknown>;
}

/**
 * Process-level hooks from the runner. Undefined fields mean the real
 * defaults (global fetch, `os.homedir()`, `process.platform`, a real timer,
 * the system browser).
 */
export interface RuntimeHooks {
  fetchImpl?: FetchLike;
  homedir?: string;
  platform?: NodeJS.Platform;
  /** Waits between setup polls (tests advance a fake clock instead). */
  sleep?: (ms: number) => Promise<void>;
  /** Opens a URL in a browser; resolves false when none could be started. */
  openUrl?: (url: string) => Promise<boolean>;
}

/** Everything a command's `run` receives. */
export interface CommandContext {
  readonly spec: CommandSpec;
  /** Full command name, e.g. `visitor act`. */
  readonly command: string;
  /** Parsed and validated flags keyed by name without dashes. Integers/numbers are numbers. */
  readonly flags: Readonly<Record<string, FlagValue>>;
  readonly positionals: readonly string[];
  readonly env: Env;
  readonly cwd: string;
  readonly mode: CommandMode;
  readonly io: CommandIO;
  /** Record writes/spends/secrets here; the transport records requests itself. */
  readonly effects: Effects;
  /** `ctx.warnings.add(code, message)`: printed to stderr now and listed in the document. */
  readonly warnings: Warnings;
  readonly store: StoreAccess;
  readonly version: string;
  readonly userAgent: string;
  readonly registry: RegistryView;
  /** Process-level hooks the runner was given (tests inject fetch and home); `mcp` hands them to every tool call. */
  readonly runtime?: RuntimeHooks;
  now(): Date;
  /**
   * Data-plane client for the read key or the visitor key. Throws
   * `NO_CREDENTIALS` (exit 3) when the key (or, for `visitor`, the agent id)
   * is missing. In demo mode it serves fixtures with synthetic keys.
   */
  createDataClient(kind: "read" | "visitor", options?: DataClientOptions): Promise<DataClient>;
  /** Control-plane client (no key; `GET /_developer/signup`, Phase 2 grant routes). Demo-aware. */
  createControlClient(options?: { timeoutMs?: number }): HttpClient;
  /** Keyless client on the data origin without `/v1` (static files such as the CLI manifest). Demo-aware. */
  createPublicClient(options?: { timeoutMs?: number }): HttpClient;
  /** y/N prompt on stderr; non-interactive sessions throw `CONFIRMATION_REQUIRED` (exit 10). */
  confirm(question: string): Promise<boolean>;
  /** Hidden-input prompt; non-interactive sessions throw `INPUT_REQUIRED` (exit 10). */
  promptHidden(question: string): Promise<string>;
  /** Applies `--execute` + `writePolicy` (plan §3.3); throws exit 4/10 codes when not authorized. */
  authorizeWrite(input: AuthorizeWriteInput): Promise<WriteAuthorization>;
}

/** Identity helper that keeps command literals type-checked. */
export function defineCommand(spec: CommandSpec): CommandSpec {
  return spec;
}

// ---------------------------------------------------------------------------
// Global flags (plan §4)
// ---------------------------------------------------------------------------

export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "json", type: "boolean", description: "Print exactly one JSON document on stdout (the default when stdout is not a TTY)." },
  { name: "output", type: "string", enum: ["human", "json"], placeholder: "human|json", description: "Force human text or JSON output." },
  { name: "profile", type: "string", placeholder: "NAME", description: "Credential profile (default: ARCOPOLIS_PROFILE, arcopolis.json, config, then \"default\")." },
  { name: "no-input", type: "boolean", description: "Never prompt; a step that needs a person exits 10." },
  { name: "verbose", type: "boolean", description: "Redacted request trace on stderr." },
  { name: "quiet", type: "boolean", description: "Suppress progress and warnings on stderr." },
  { name: "timeout", type: "number", min: 1, max: 600, placeholder: "SECONDS", description: "Override every request timeout." },
  { name: "demo", type: "boolean", description: "Serve bundled fixtures: no network, no credentials, no files written." },
  { name: "help", type: "boolean", short: "h", description: "Show help; with --json, print this command's schema entry." },
  { name: "version", type: "boolean", description: "Print the CLI version." },
];

/** Global flags that take a value (used when locating the command words in argv). */
export const GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set(
  GLOBAL_FLAGS.filter((flag) => flag.type !== "boolean").map((flag) => flag.name),
);

// ---------------------------------------------------------------------------
// Flag accessors
// ---------------------------------------------------------------------------

/** String flag value (first when repeated). */
export function flagString(flags: Readonly<Record<string, FlagValue>>, name: string): string | undefined {
  const value = flags[name];
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : undefined;
  return typeof value === "string" ? value : undefined;
}

/** Boolean flag value (false when absent). */
export function flagBoolean(flags: Readonly<Record<string, FlagValue>>, name: string): boolean {
  return flags[name] === true;
}

/** Numeric flag value. */
export function flagNumber(flags: Readonly<Record<string, FlagValue>>, name: string): number | undefined {
  const value = flags[name];
  return typeof value === "number" ? value : undefined;
}

/** Repeated string flag values (`--query k=v --query k2=v2`). */
export function flagStrings(flags: Readonly<Record<string, FlagValue>>, name: string): string[] {
  const value = flags[name];
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" ? [value] : [];
}

/** Throws a usage error (exit 2). */
export function usageError(message: string, hint?: string): CliError {
  return new CliError("USAGE_ERROR", message, { hint, humanDecision: false });
}

// ---------------------------------------------------------------------------
// Output schema helpers
// ---------------------------------------------------------------------------

/** `outputSchema` for a command whose `data` is an object with the given properties. */
export function objectSchema(properties: Record<string, JsonSchema> = {}, required: string[] = []): JsonSchema {
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: true };
}
