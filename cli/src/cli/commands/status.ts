/**
 * `arcopolis status` (plan §4.1): the first command an agent runs. Offline:
 * it reads the credential store, `arcopolis.json`, the visitor state file,
 * and a few project files, and reports which source won for every value.
 * It never creates a network client, so it makes zero requests.
 *
 * The local inspection helpers here are also used by `doctor` and `setup`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { displayPath, isValidApiKey, type ResolvedCredentials, type ResolvedKey, type WritePolicy } from "../../core/credentials.js";
import { errno } from "../../core/files.js";
import { gitIsIgnored } from "../../core/gitignore.js";
import { grantLiveUntil } from "../../core/grant.js";
import { PROJECT_FILE, resolveStateFile, stateFileSplit, type LoadedProject } from "../../core/project.js";
import { redactKey } from "../../core/redact.js";
import { INIT_PATHS, readBlockVersion } from "../../init/init.js";
import { defineCommand, objectSchema, type CommandContext, type CommandSpec, type DocumentView, type NextStep } from "../spec.js";

/** Stored keys verified more recently than this are trusted without a request. */
export const VERIFY_FRESH_MS = 24 * 60 * 60 * 1000;

/** The starter's safe replay window for a pending visitor action. */
export const PENDING_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Project files that may hold the managed agent-instruction block. */
export const AGENT_BLOCK_FILES: readonly string[] = [INIT_PATHS.agents, INIT_PATHS.claude, INIT_PATHS.cursorRule, INIT_PATHS.skill];

/** Project files that may hold the MCP stanza. */
export const MCP_FILES: readonly string[] = [INIT_PATHS.claudeMcp, INIT_PATHS.cursorMcp];

/** Probe paths for the two default `.gitignore` entries (`.arcopolis-*`, `.arcopolis/`). */
export const GITIGNORE_PROBES: ReadonlyArray<{ entry: string; probe: string }> = [
  { entry: ".arcopolis-*", probe: ".arcopolis-pending.json" },
  { entry: ".arcopolis/", probe: ".arcopolis/credentials.json" },
];

/** Credential-related environment variables, reported by name only. */
export const CREDENTIAL_ENV_NAMES: readonly string[] = [
  "ARCOPOLIS_API_KEY",
  "AGNTS_API_KEY",
  "ARCOPOLIS_VISITOR_API_KEY",
  "ARCOPOLIS_VISITOR_AGENT_ID",
  "ARCOPOLIS_PROFILE",
  "ARCOPOLIS_API_BASE",
  "AGNTS_API_BASE_URL",
  "ARCOPOLIS_DEVELOPER_BASE",
  "ARCOPOLIS_CONFIG_DIR",
  "ARCOPOLIS_ALLOW_CUSTOM_BASE",
];

/** Which of {@link CREDENTIAL_ENV_NAMES} are set (non-empty). Names only, never values. */
export function setCredentialEnvNames(env: Readonly<Record<string, string | undefined>>): string[] {
  return CREDENTIAL_ENV_NAMES.filter((name) => Boolean(env[name]?.trim()));
}

/** Summary of one resolved key. Never carries the key itself. */
export interface KeySummary {
  configured: boolean;
  keyPrefix?: string;
  source?: ResolvedKey["source"];
  variable?: string;
  formatValid?: boolean;
  tier?: number | null;
  origin?: string | null;
  lastVerifiedAt?: string | null;
  /** True when an environment variable overrides a key saved in the store. */
  shadowsStoredKey?: boolean;
}

/** Visitor summary: the key plus the agent id and its source. */
export interface VisitorSummary extends KeySummary {
  agentId?: string | null;
  agentIdSource?: string | null;
  handle?: string | null;
  worldId?: string | null;
  missing?: string[];
}

/** Local visitor state file (`.arcopolis-pending.json`) summary. The action body is never echoed. */
export interface PendingActionSummary {
  file: string;
  status: "pending" | "completed" | "invalid";
  kind: string | null;
  agentId: string | null;
  createdAt: string | null;
  completedAt: string | null;
  ageHours: number | null;
  /** For a pending action: still inside the 24 h replay window. */
  replayWindowOpen: boolean | null;
}

/** Pending grant summary (secrets such as the device code and private key are never read out). */
export interface PendingGrantSummary {
  userCode: string | null;
  expiresAt: string | null;
  expired: boolean | null;
}

/** What `status` and `doctor` know about the project directory. */
export interface ProjectInspection {
  root: string;
  gitRoot: string | null;
  configFile: string | null;
  /** Highest managed agent-block version found (`v1`), or null. */
  agentInstructions: string | null;
  agentFiles: Array<{ path: string; version: string }>;
  mcp: Array<{ path: string; allowWrites: boolean }>;
  /** `ok`, `partial`, `missing`, or `no_repo` for the two default entries. */
  gitignore: "ok" | "partial" | "missing" | "no_repo";
  gitignoreMissing: string[];
}

/** Summarizes a resolved read key (redacted). */
export function summarizeReadKey(resolved: ResolvedCredentials): KeySummary {
  const key = resolved.read;
  if (!key) return { configured: false };
  const record = key.readRecord ?? resolved.storeProfile?.readKey ?? null;
  const summary: KeySummary = {
    configured: true,
    keyPrefix: redactKey(key.value),
    source: key.source,
    formatValid: isValidApiKey(key.value),
    tier: key.source === "store" || key.source === "demo" ? (record?.tier ?? null) : null,
    origin: key.origin,
    lastVerifiedAt: key.source === "store" ? (record?.lastVerifiedAt ?? null) : null,
  };
  if (key.variable) summary.variable = key.variable;
  if (key.source !== "store" && resolved.storeProfile?.readKey?.key) summary.shadowsStoredKey = true;
  return summary;
}

/** Summarizes a resolved visitor key and agent id (redacted). */
export function summarizeVisitor(resolved: ResolvedCredentials): VisitorSummary {
  const key = resolved.visitor;
  const record = key?.visitorRecord ?? resolved.storeProfile?.visitor ?? null;
  const agent = resolved.agentId;
  if (!key) {
    const summary: VisitorSummary = { configured: false };
    if (agent) {
      summary.agentId = agent.value;
      summary.agentIdSource = agent.source;
      summary.missing = ["key"];
    }
    return summary;
  }
  const summary: VisitorSummary = {
    configured: true,
    keyPrefix: redactKey(key.value),
    source: key.source,
    formatValid: isValidApiKey(key.value),
    origin: key.origin,
    lastVerifiedAt: key.source === "store" ? (record?.lastVerifiedAt ?? null) : null,
    agentId: agent?.value ?? null,
    agentIdSource: agent?.source ?? null,
    handle: record?.handle ?? null,
    worldId: record?.worldId ?? null,
  };
  if (key.variable) summary.variable = key.variable;
  if (key.source !== "store" && resolved.storeProfile?.visitor?.key) summary.shadowsStoredKey = true;
  if (!agent) summary.missing = ["agentId"];
  return summary;
}

/** True when an ISO timestamp is within {@link VERIFY_FRESH_MS} of `now`. */
export function isFresh(timestamp: string | null | undefined, now: Date): boolean {
  if (!timestamp) return false;
  const at = Date.parse(timestamp);
  return Number.isFinite(at) && now.getTime() - at >= 0 && now.getTime() - at < VERIFY_FRESH_MS;
}

/** `~/.config/arcopolis (user)` style label for the store. */
export function storeLabel(ctx: CommandContext): string {
  return `${displayPath(ctx.store.paths.dir)} (${ctx.store.paths.kind})`;
}

async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const code = errno(error);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return null;
    throw error;
  }
}

/** Relative display path from cwd (falls back to the absolute path). */
export function relativeDisplay(cwd: string, target: string): string {
  const relative = path.relative(cwd, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : target;
}

/**
 * Reads the visitor state file without echoing its body. Returns null when
 * there is none. In demo mode nothing local is read.
 */
export async function readPendingAction(ctx: CommandContext, project: LoadedProject): Promise<PendingActionSummary | null> {
  if (ctx.mode.demo) return null;
  const file = resolveStateFile(project, ctx.cwd);
  const split = stateFileSplit(project, ctx.cwd);
  if (split) {
    ctx.warnings.add(
      "STATE_FILE_CONFLICT",
      `arcopolis.json points the visitor state at ${relativeDisplay(ctx.cwd, file)}, but ${relativeDisplay(ctx.cwd, split)} also exists here; visitor commands refuse until one is resolved.`,
    );
  }
  const text = await readTextIfExists(file);
  if (text === null) return null;
  const display = relativeDisplay(ctx.cwd, file);
  let state: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    state = parsed as Record<string, unknown>;
  } catch {
    return {
      file: display,
      status: "invalid",
      kind: null,
      agentId: null,
      createdAt: null,
      completedAt: null,
      ageHours: null,
      replayWindowOpen: null,
    };
  }
  const status = state.status === "pending" || state.status === "completed" ? state.status : "invalid";
  const body = state.body && typeof state.body === "object" && !Array.isArray(state.body) ? (state.body as Record<string, unknown>) : null;
  const kind = body ? (Object.keys(body)[0] ?? null) : null;
  const createdAt = typeof state.createdAt === "string" ? state.createdAt : null;
  const createdMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  const ageMs = Number.isFinite(createdMs) ? ctx.now().getTime() - createdMs : Number.NaN;
  return {
    file: display,
    status: state.schemaVersion === 1 ? status : "invalid",
    kind,
    agentId: typeof state.agentId === "string" ? state.agentId : null,
    createdAt,
    completedAt: typeof state.completedAt === "string" ? state.completedAt : null,
    ageHours: Number.isFinite(ageMs) ? Math.round((ageMs / 3_600_000) * 10) / 10 : null,
    replayWindowOpen: status === "pending" && Number.isFinite(ageMs) ? ageMs >= 0 && ageMs < PENDING_REPLAY_WINDOW_MS : null,
  };
}

/** Reads only the non-secret fields of `pending-grant.json`; null when absent or in demo mode. */
export async function readPendingGrant(ctx: CommandContext): Promise<PendingGrantSummary | null> {
  if (ctx.mode.demo) return null;
  const grant = await ctx.store.credentialStore.readJson<Record<string, unknown>>("pending-grant.json");
  if (!grant) return null;
  const expiresAt = typeof grant.expiresAt === "string" ? grant.expiresAt : null;
  const createdAt = typeof grant.createdAt === "string" ? grant.createdAt : null;
  const expiresMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  // A claim or an approval can extend the deadline the file recorded, so the
  // grant is dead only past every deadline it could have reached.
  const liveUntil = expiresAt && createdAt ? grantLiveUntil({ expiresAt, createdAt }) : expiresMs;
  return {
    userCode: typeof grant.userCode === "string" ? grant.userCode : null,
    expiresAt,
    expired: Number.isFinite(liveUntil) ? liveUntil <= ctx.now().getTime() : null,
  };
}

/**
 * Inspects the project: `arcopolis.json`, the managed agent block, the MCP
 * stanza, and `.gitignore` coverage of the default entries (via
 * `git check-ignore`, a local query).
 */
export async function inspectProject(ctx: CommandContext, project: LoadedProject): Promise<ProjectInspection> {
  const root = project.root;
  const agentFiles: ProjectInspection["agentFiles"] = [];
  for (const relative of AGENT_BLOCK_FILES) {
    const text = await readTextIfExists(path.join(root, relative));
    // Same parser as `init`, so a block quoted inside a code fence is not mistaken for the managed one.
    const version = text ? readBlockVersion(text) : null;
    if (version) agentFiles.push({ path: relative, version });
  }
  const versions = agentFiles.map((entry) => Number.parseInt(entry.version.slice(1), 10));
  const mcp: ProjectInspection["mcp"] = [];
  for (const relative of MCP_FILES) {
    const text = await readTextIfExists(path.join(root, relative));
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as { mcpServers?: Record<string, { args?: unknown }> };
      const server = parsed.mcpServers?.arcopolis;
      if (server && typeof server === "object") {
        const args = Array.isArray(server.args) ? server.args : [];
        mcp.push({ path: relative, allowWrites: args.includes("--allow-writes") });
      }
    } catch {
      // A malformed MCP file is reported by doctor as a missing stanza.
    }
  }
  let gitignore: ProjectInspection["gitignore"] = "no_repo";
  const gitignoreMissing: string[] = [];
  if (project.gitRoot) {
    let covered = 0;
    let repo = false;
    for (const { entry, probe } of GITIGNORE_PROBES) {
      const result = await gitIsIgnored(project.gitRoot, path.join(project.gitRoot, probe));
      repo ||= result.repo;
      if (result.result) covered += 1;
      else gitignoreMissing.push(entry);
    }
    if (repo) gitignore = covered === GITIGNORE_PROBES.length ? "ok" : covered === 0 ? "missing" : "partial";
    else gitignoreMissing.length = 0;
  }
  return {
    root,
    gitRoot: project.gitRoot,
    configFile: project.file ? relativeDisplay(ctx.cwd, project.file) : null,
    agentInstructions: versions.length ? `v${Math.max(...versions)}` : null,
    agentFiles,
    mcp,
    gitignore,
    gitignoreMissing,
  };
}

/** The `status` data document. */
export interface StatusData {
  cliVersion: string;
  profile: string;
  profileSource: string;
  profileExists: boolean;
  store: string;
  read: KeySummary;
  visitor: VisitorSummary;
  pendingGrant: PendingGrantSummary | null;
  pendingAction: PendingActionSummary | null;
  /** The live-write policy in force and the config.json that set it (null: the built-in default). */
  writePolicy: { policy: WritePolicy; source: string | null };
  project: {
    configFile: string | null;
    agentInstructions: string | null;
    gitignore: ProjectInspection["gitignore"];
    mcp: boolean;
  };
}

/** Builds the offline status (no network). Exported for the MCP `arcopolis_status` tool. */
export async function collectStatus(ctx: CommandContext): Promise<{ data: StatusData; next: NextStep[] }> {
  const resolved = await ctx.store.resolved();
  const project = await ctx.store.project();
  const [inspection, pendingAction, pendingGrant] = await Promise.all([
    inspectProject(ctx, project),
    readPendingAction(ctx, project),
    readPendingGrant(ctx),
  ]);
  const read = summarizeReadKey(resolved);
  const visitor = summarizeVisitor(resolved);
  const policy = await ctx.store.writePolicy();
  const data: StatusData = {
    cliVersion: ctx.version,
    profile: resolved.profile.name,
    profileSource: resolved.profile.source,
    profileExists: resolved.profile.exists,
    store: storeLabel(ctx),
    read,
    visitor,
    pendingGrant,
    pendingAction,
    writePolicy: { policy: policy.policy, source: policy.source ? displayPath(policy.source) : null },
    project: {
      configFile: inspection.configFile ?? (project.file ? PROJECT_FILE : null),
      agentInstructions: inspection.agentInstructions,
      gitignore: inspection.gitignore,
      mcp: inspection.mcp.length > 0,
    },
  };
  const next: NextStep[] = [];
  if (pendingAction?.status === "pending") {
    next.push({
      command: "arcopolis visitor pending --json",
      why: "A visitor action may be unresolved; check it before any new action",
      humanDecision: false,
    });
  }
  if (pendingGrant && pendingGrant.expired === false) {
    next.push({ command: "arcopolis setup --json", why: "Resume the pending setup approval (same code)", humanDecision: false });
  } else if (!read.configured && !visitor.configured) {
    next.push({ command: "arcopolis setup --json", why: "Get credentials with one human approval", humanDecision: false });
  }
  if (read.configured) {
    next.push({ command: "arcopolis agents list --per-page 5 --json", why: "First read", humanDecision: false });
  }
  if (visitor.configured && visitor.agentId) {
    next.push({ command: "arcopolis visitor status --json", why: "Cached visitor state (no network)", humanDecision: false });
  }
  if (inspection.gitignore === "missing" || inspection.gitignore === "partial") {
    next.push({ command: "arcopolis init --json", why: "Add the .gitignore block and agent instructions", humanDecision: false });
  }
  return { data, next };
}

function describeKey(label: string, summary: KeySummary): string {
  if (!summary.configured) return `  ${label.padEnd(9)} not configured`;
  const source = summary.variable ? `${summary.source} (${summary.variable})` : summary.source;
  const parts = [`${summary.keyPrefix}`, `from ${source}`];
  if (summary.tier) parts.push(`tier ${summary.tier}`);
  if (summary.lastVerifiedAt) parts.push(`verified ${new Date(summary.lastVerifiedAt).toLocaleString()}`);
  if (summary.formatValid === false) parts.push("INVALID FORMAT");
  if (summary.shadowsStoredKey) parts.push("overrides the stored key");
  return `  ${label.padEnd(9)} ${parts.join(", ")}`;
}

function renderStatusHuman(view: DocumentView): string {
  const data = view.data as StatusData;
  const lines = [
    `arcopolis ${data.cliVersion}`,
    `  Profile   ${data.profile} (${data.profileSource}${data.profileExists ? "" : ", not in the store"})`,
    `  Store     ${data.store}`,
    describeKey("Read key", data.read),
    describeKey("Visitor", data.visitor),
  ];
  if (data.visitor.agentId) lines.push(`  Agent     ${data.visitor.agentId} (${data.visitor.agentIdSource ?? "unknown"})`);
  if (data.pendingAction) {
    lines.push(`  Pending   ${data.pendingAction.status} ${data.pendingAction.kind ?? ""} in ${data.pendingAction.file}`.trimEnd());
  }
  if (data.pendingGrant) lines.push(`  Grant     pending approval ${data.pendingGrant.userCode ?? ""}`.trimEnd());
  lines.push(`  Writes    writePolicy ${data.writePolicy.policy}${data.writePolicy.source ? ` (from ${data.writePolicy.source})` : " (default)"}`);
  lines.push(
    `  Project   ${data.project.configFile ?? "no arcopolis.json"}; agent block ${data.project.agentInstructions ?? "none"}; .gitignore ${data.project.gitignore}`,
  );
  for (const step of view.next) lines.push(`Next: ${step.command}  (${step.why})`);
  return `${lines.join("\n")}\n`;
}

export const commands: CommandSpec[] = [
  defineCommand({
    name: "status",
    summary: "Offline summary: profile, redacted keys and their sources, pending state, project files",
    description:
      "Makes no network request. Reports which source won for each key (environment, legacy environment, or store), " +
      "the pending visitor action and grant, and whether the project has the .gitignore block and agent instructions.",
    phase: 1,
    credentials: "none",
    confirmation: "none",
    network: "none",
    effects: { writes: [], spends: [] },
    flags: [],
    positionals: [],
    errors: ["INSECURE_CREDENTIAL_FILE", "CREDENTIALS_FILE_INVALID", "INVALID_FLAG_VALUE"],
    exitCodes: [0, 1, 2, 3],
    outputSchema: objectSchema(
      {
        cliVersion: { type: "string" },
        profile: { type: "string" },
        profileSource: { type: "string" },
        profileExists: { type: "boolean" },
        store: { type: "string" },
        read: { type: "object", properties: { configured: { type: "boolean" }, keyPrefix: { type: "string" }, source: { type: "string" } } },
        visitor: { type: "object", properties: { configured: { type: "boolean" }, agentId: { type: ["string", "null"] } } },
        pendingGrant: { type: ["object", "null"] },
        pendingAction: { type: ["object", "null"] },
        writePolicy: {
          type: "object",
          properties: { policy: { enum: ["flag", "tty-only", "deny"] }, source: { type: ["string", "null"] } },
          description: "The most restrictive writePolicy of the active store's and the user's config.json, and the file that set it.",
        },
        project: {
          type: "object",
          properties: {
            configFile: { type: ["string", "null"] },
            agentInstructions: { type: ["string", "null"] },
            gitignore: { enum: ["ok", "partial", "missing", "no_repo"] },
            mcp: { type: "boolean" },
          },
        },
      },
      ["cliVersion", "profile", "store", "read", "visitor", "pendingGrant", "pendingAction", "project"],
    ),
    examples: ["arcopolis status --json"],
    async run(ctx) {
      const { data, next } = await collectStatus(ctx);
      return { data, next };
    },
    renderHuman: renderStatusHuman,
  }),
];
