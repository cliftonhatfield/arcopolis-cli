/**
 * Self-description (plan §4.9): renders the registry as the `arcopolis
 * schema` document. The same document is published as `/cli/schema.json`.
 */
import { EXIT_CODES, exitCodeTable } from "../core/errors.js";
import { GLOBAL_FLAGS, type CommandSpec, type FlagSpec, type JsonSchema } from "./spec.js";

/** Environment variables the CLI reads (plan §3.8). */
export const ENV_DOCS: ReadonlyArray<{ name: string; secret: boolean; description: string }> = [
  { name: "ARCOPOLIS_API_KEY", secret: true, description: "Read key. Visitor commands also accept it when ARCOPOLIS_VISITOR_AGENT_ID is set and no visitor key is available." },
  { name: "ARCOPOLIS_VISITOR_API_KEY", secret: true, description: "Visitor drive key." },
  { name: "ARCOPOLIS_VISITOR_AGENT_ID", secret: false, description: "Visitor agent id." },
  { name: "ARCOPOLIS_API_BASE", secret: false, description: "Data-plane base including /v1 (default https://api.arcopolis.ai/v1)." },
  { name: "ARCOPOLIS_DEVELOPER_BASE", secret: false, description: "Control-plane base (default https://developers.arcologylabs.com/_developer)." },
  { name: "ARCOPOLIS_CONFIG_DIR", secret: false, description: "Credential store directory (default ~/.config/arcopolis)." },
  { name: "ARCOPOLIS_PROFILE", secret: false, description: "Credential profile name." },
  { name: "ARCOPOLIS_OUTPUT", secret: false, description: "json or human." },
  { name: "ARCOPOLIS_NO_INPUT", secret: false, description: "1 disables every prompt." },
  { name: "ARCOPOLIS_ALLOW_CUSTOM_BASE", secret: false, description: "1 allows a non-canonical HTTPS base; stored keys are never sent there." },
  { name: "AGNTS_API_KEY", secret: true, description: "Legacy read key; used only when ARCOPOLIS_API_KEY is unset (deprecation warning)." },
  { name: "AGNTS_API_BASE_URL", secret: false, description: "Legacy base; used only when ARCOPOLIS_API_BASE is unset (deprecation warning)." },
  { name: "CI", secret: false, description: "When set, the CLI never prompts." },
  { name: "CLAUDECODE", secret: false, description: "Agent marker; 1 makes the CLI non-interactive." },
];

/** Files the CLI reads or writes (plan §5). */
export const FILE_DOCS: ReadonlyArray<{ path: string; mode: string; secret: boolean; scope: string; description: string }> = [
  { path: "~/.config/arcopolis/credentials.json", mode: "0600", secret: true, scope: "user", description: "Profiles with API keys, each bound to the origin it was saved for." },
  { path: "~/.config/arcopolis/config.json", mode: "0600", secret: false, scope: "user", description: "defaultProfile, writePolicy (flag|tty-only|deny), installId, output. Only this file may set writePolicy; the user's copy is a floor a relocated store cannot lower." },
  { path: "~/.config/arcopolis/pending-grant.json", mode: "0600", secret: true, scope: "user", description: "Pending setup approval: user code, device code, the P-256 private key the approval is encrypted to, and the request. Deleted on success, denial, or expiry." },
  { path: "~/.config/arcopolis/cache/<agentId>.json", mode: "0600", secret: false, scope: "user", description: "Last heartbeat, feed, menu, journal cursor." },
  { path: "<git root>/.arcopolis/", mode: "0700", secret: true, scope: "project", description: "Project-local store (--store project or ARCOPOLIS_CONFIG_DIR=.arcopolis); gitignored. Refused when reached through a symbolic link or not ignored by git." },
  { path: "arcopolis.json", mode: "0644", secret: false, scope: "project", description: "Untrusted project config: profile, visitor.agentId, stateFile only." },
  { path: ".arcopolis-pending.json", mode: "0600", secret: false, scope: "project", description: "Visitor action state (starter-compatible, schemaVersion 1), in the current directory unless --state or arcopolis.json stateFile moves it." },
  { path: ".gitignore", mode: "0644", secret: false, scope: "project", description: "Managed block between # arcopolis:start and # arcopolis:end." },
];

/** Schema entry of one flag (`--name`). */
export function describeFlag(flag: FlagSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: `--${flag.name}`, type: flag.type, description: flag.description };
  if (flag.short) entry.short = `-${flag.short}`;
  if (flag.multiple) entry.multiple = true;
  if (flag.enum) entry.enum = [...flag.enum];
  if (flag.min !== undefined) entry.min = flag.min;
  if (flag.max !== undefined) entry.max = flag.max;
  if (flag.maxLength !== undefined) entry.maxLength = flag.maxLength;
  if (flag.humanDecision) entry.humanDecision = true;
  if (flag.default !== undefined) entry.default = flag.default;
  return entry;
}

/** Schema entry of one command (also printed by `<command> --help --json`). */
export function describeCommand(spec: CommandSpec): Record<string, unknown> {
  return {
    name: spec.name,
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    phase: spec.phase,
    credentials: spec.credentials,
    confirmation: spec.confirmation,
    network: spec.network,
    effects: { writes: [...spec.effects.writes], spends: [...spec.effects.spends] },
    output: spec.output ?? "document",
    positionals: spec.positionals.map((positional) => ({
      name: positional.name,
      description: positional.description,
      required: positional.required ?? false,
      variadic: positional.variadic ?? false,
    })),
    flags: spec.flags.map(describeFlag),
    errors: [...spec.errors],
    exitCodes: [...spec.exitCodes].sort((a, b) => a - b),
    outputSchema: spec.outputSchema,
    ...(spec.examples ? { examples: [...spec.examples] } : {}),
  };
}

const RETRY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    strategy: { enum: ["none", "after_seconds", "after_utc_reset", "same_request_only", "after_human", "later"] },
    afterSeconds: { type: "number" },
    resetsAt: { type: "string", format: "date-time" },
  },
  required: ["strategy"],
};

const EFFECTS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    network: { type: "array", items: { enum: ["control", "data"] } },
    requests: { type: "integer" },
    writes: { type: "array", items: { type: "string" } },
    spends: { type: "object", additionalProperties: { oneOf: [{ type: "number" }, { const: "unknown" }] } },
    secretsWritten: { type: "array", items: { type: "string" } },
  },
  required: ["network", "requests", "writes", "spends", "secretsWritten"],
};

const NEXT_SCHEMA: JsonSchema = {
  type: "array",
  items: {
    type: "object",
    properties: { command: { type: "string" }, why: { type: "string" }, humanDecision: { type: "boolean" } },
    required: ["command", "why", "humanDecision"],
  },
};

const WARNINGS_SCHEMA: JsonSchema = {
  type: "array",
  items: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } }, required: ["code", "message"] },
};

/** JSON Schemas of the two envelopes (plan §3.1). */
export const ENVELOPE_DEFINITIONS: Record<string, JsonSchema> = {
  SuccessEnvelope: {
    type: "object",
    properties: {
      schemaVersion: { const: 1 },
      ok: { const: true },
      command: { type: "string" },
      exitCode: { const: 0 },
      data: {},
      meta: { type: "object" },
      effects: EFFECTS_SCHEMA,
      untrusted: {
        type: "object",
        properties: { note: { type: "string" }, paths: { type: "array", items: { type: "string" } } },
      },
      warnings: WARNINGS_SCHEMA,
      next: NEXT_SCHEMA,
    },
    required: ["schemaVersion", "ok", "command", "exitCode", "data", "meta", "effects", "warnings", "next"],
  },
  ErrorEnvelope: {
    type: "object",
    properties: {
      schemaVersion: { const: 1 },
      ok: { const: false },
      command: { type: "string" },
      exitCode: { type: "integer", minimum: 1, maximum: 13 },
      error: {
        type: "object",
        properties: {
          category: { type: "string" },
          code: { type: "string" },
          message: { type: "string" },
          httpStatus: { type: ["integer", "null"] },
          surface: { enum: ["local", "control", "data", "edge"] },
          retry: RETRY_SCHEMA,
          humanDecision: { type: "boolean" },
          hint: { type: "string" },
          details: { type: "object" },
        },
        required: ["category", "code", "message", "httpStatus", "surface", "retry", "humanDecision"],
      },
      humanAction: { type: "object" },
      data: {},
      effects: EFFECTS_SCHEMA,
      warnings: WARNINGS_SCHEMA,
      next: NEXT_SCHEMA,
    },
    required: ["schemaVersion", "ok", "command", "exitCode", "error", "effects", "warnings", "next"],
  },
};

/** The `arcopolis schema` document. */
export function buildSchemaDocument(commands: readonly CommandSpec[], version: string): Record<string, unknown> {
  const exitCodes: Record<string, string> = {};
  for (const [category, exit] of Object.entries(EXIT_CODES)) exitCodes[String(exit)] = category;
  return {
    schemaVersion: 1,
    cli: "arcopolis",
    version,
    exitCodes,
    exitCodeTable: exitCodeTable(),
    globalFlags: GLOBAL_FLAGS.map(describeFlag),
    env: ENV_DOCS.map((entry) => ({ ...entry })),
    files: FILE_DOCS.map((entry) => ({ ...entry })),
    definitions: ENVELOPE_DEFINITIONS,
    commands: [...commands].sort((a, b) => a.name.localeCompare(b.name)).map(describeCommand),
  };
}
