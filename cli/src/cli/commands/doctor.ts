/**
 * `arcopolis doctor [--online [--verify]] [--fix-permissions]` (plan §4.4).
 *
 * Offline by default: Node version, store modes, key formats, which
 * environment overrides win (names only), bases, `.gitignore` coverage, keys
 * committed to git (`git grep`, file names only), the pending action and
 * grant, and the agent block / MCP stanza. `--online` adds at most
 * `GET /_developer/signup` (0 writes) and one `GET /v1` per stored key that
 * was not verified in 24 hours (every stored key with `--verify`). It never
 * heartbeats or reads journal, standing, or usage.
 *
 * Check failures are reported in `data.checks`; doctor itself exits 0.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { displayPath, inspectStoreLocation, isValidApiKey, type ResolvedCredentials } from "../../core/credentials.js";
import { CliError } from "../../core/errors.js";
import { DEFAULT_IGNORE_ENTRIES, gitIsIgnored, readManagedLines } from "../../core/gitignore.js";
import { BLOCK_VERSION } from "../../init/templates.js";
import { defineCommand, flagBoolean, objectSchema, usageError, type CommandContext, type CommandSpec, type DocumentView, type NextStep } from "../spec.js";
import { markKeyVerified } from "./auth.js";
import {
  inspectProject,
  isFresh,
  readPendingAction,
  readPendingGrant,
  setCredentialEnvNames,
  summarizeReadKey,
  summarizeVisitor,
} from "./status.js";

/** Minimum supported Node major version. */
export const MIN_NODE_MAJOR = 22;

/** The pattern `doctor` greps tracked files for (file names only are reported). */
export const COMMITTED_KEY_PATTERN = "agnts_[0-9a-f]{64}";

export type CheckStatus = "ok" | "warn" | "fail" | "info" | "skip";

/** One doctor finding. Never carries a key. */
export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  code?: string;
  details?: Record<string, unknown>;
  /** A command that fixes or investigates the finding. */
  fix?: string;
  /** The fix is a human step (for example rotating a leaked key). */
  fixNeedsHuman?: boolean;
}

/** The `doctor` data document. */
export interface DoctorData {
  healthy: boolean;
  online: boolean;
  summary: Record<CheckStatus, number>;
  checks: DoctorCheck[];
  requests: number;
  spentDailyBudget: false;
  message: string;
}

export interface DoctorOptions {
  online: boolean;
  verify: boolean;
  fixPermissions: boolean;
}

/** `git grep -I -l -E agnts_[0-9a-f]{64}` in the repository: tracked file names only. */
export function gitGrepCommittedKeys(root: string): Promise<{ repo: boolean; files: string[] }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["grep", "-I", "-l", "-E", COMMITTED_KEY_PATTERN],
      { cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (!error) {
          resolve({ repo: true, files: String(stdout).split("\n").map((line) => line.trim()).filter(Boolean) });
          return;
        }
        const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1;
        resolve({ repo: code === 1, files: [] });
      },
    );
  });
}

function errorCode(error: unknown): { code: string; message: string } {
  if (error instanceof CliError) return { code: error.code, message: error.message };
  return { code: "INTERNAL", message: error instanceof Error ? error.name : "unexpected error" };
}

function ageText(timestamp: string, now: Date): string {
  const hours = Math.max(0, (now.getTime() - Date.parse(timestamp)) / 3_600_000);
  return hours < 1 ? `${Math.round(hours * 60)} minutes` : `${Math.round(hours * 10) / 10} hours`;
}

async function checkStorePermissions(ctx: CommandContext, fix: boolean): Promise<DoctorCheck> {
  const store = ctx.store.credentialStore;
  const dir = displayPath(ctx.store.paths.dir);
  if (ctx.mode.demo) return { id: "store_permissions", status: "skip", message: "Demo mode uses a synthetic in-memory store." };
  if (!ctx.store.paths.posixModes) {
    return { id: "store_permissions", status: "warn", message: `This platform does not enforce POSIX modes; protect ${dir} yourself.` };
  }
  try {
    let findings = await store.inspectPermissions();
    if (findings.length === 0) return { id: "store_permissions", status: "info", message: `The store ${dir} does not exist yet.` };
    let fixed: string[] = [];
    if (fix && findings.some((finding) => !finding.ok)) {
      fixed = (await store.fixPermissions()).map((file) => displayPath(file));
      if (fixed.length) ctx.effects.write("credential_store");
      findings = await store.inspectPermissions();
    }
    const bad = findings.filter((finding) => !finding.ok);
    if (bad.length) {
      return {
        id: "store_permissions",
        status: "fail",
        code: "INSECURE_CREDENTIAL_FILE",
        message: `${bad.length} store path(s) are accessible to other users.`,
        details: { findings: bad.map((finding) => ({ path: displayPath(finding.path), expected: finding.expected, actual: finding.actual })) },
        fix: "arcopolis doctor --fix-permissions",
      };
    }
    return {
      id: "store_permissions",
      status: "ok",
      message: fixed.length ? `Fixed modes on ${fixed.length} path(s); ${dir} is 0700 and its files 0600.` : `${dir} is 0700 and its files 0600.`,
      ...(fixed.length ? { details: { fixed } } : {}),
    };
  } catch (error) {
    const { code, message } = errorCode(error);
    return { id: "store_permissions", status: "fail", code, message: `Could not inspect the store: ${message}` };
  }
}

/**
 * Where the store sits, with the same fail-closed rules as a write: a
 * symbolic link under the git root, or a store git does not ignore (or
 * cannot answer for), is a failure for a project or ARCOPOLIS_CONFIG_DIR
 * store and a warning for the user store. "Ignored by git" is reported only
 * when git said so.
 */
async function checkStoreLocation(ctx: CommandContext): Promise<DoctorCheck> {
  const dir = ctx.store.paths.dir;
  const kind = ctx.store.paths.kind;
  const label = `${displayPath(dir)} (${kind})`;
  if (ctx.mode.demo) return { id: "store_location", status: "skip", message: "Demo mode uses a synthetic in-memory store." };
  const location = await inspectStoreLocation(ctx.store.paths);
  if (!location.gitRoot) return { id: "store_location", status: "ok", message: `Store: ${label}.` };
  if (location.ignored === true) return { id: "store_location", status: "ok", message: `Store: ${label} (ignored by git).` };
  const strict = kind !== "user";
  if (location.symlink) {
    return {
      id: "store_location",
      status: strict ? "fail" : "warn",
      code: "STORE_PATH_SYMLINK",
      message: `Store ${label} is reached through the symbolic link ${displayPath(location.symlink)} inside a git repository; keys could land in a tracked directory.`,
      details: { symlink: displayPath(location.symlink) },
    };
  }
  const why = location.ignored === null ? "git could not tell whether it is ignored" : "it is not ignored";
  return {
    id: "store_location",
    status: strict ? "fail" : "warn",
    code: strict ? "STORE_NOT_IGNORED" : "STORE_IN_GIT_REPO",
    message: `Store ${label} is inside a git repository and ${why}; make sure it is never committed.`,
    fix: kind === "project" ? "arcopolis init" : undefined,
  };
}

async function checkCredentialsFile(ctx: CommandContext): Promise<DoctorCheck[]> {
  try {
    const credentials = await ctx.store.credentials();
    const checks: DoctorCheck[] = [];
    const names = Object.keys(credentials.profiles).sort();
    const invalid: string[] = [];
    for (const name of names) {
      const profile = credentials.profiles[name];
      if (profile?.readKey?.key !== undefined && !isValidApiKey(profile.readKey.key)) invalid.push(`${name}.readKey`);
      if (profile?.visitor?.key !== undefined && !isValidApiKey(profile.visitor.key)) invalid.push(`${name}.visitor`);
      if (profile?.visitor && !profile.visitor.agentId) invalid.push(`${name}.visitor.agentId`);
    }
    checks.push({ id: "credentials_file", status: "ok", message: `credentials.json has ${names.length} profile(s).`, details: { profiles: names } });
    if (invalid.length) {
      checks.push({
        id: "key_formats",
        status: "fail",
        code: "INVALID_KEY_FORMAT",
        message: `Stored values do not have the expected format: ${invalid.join(", ")}.`,
        fix: "arcopolis auth import --stdin",
      });
    } else if (names.length) {
      checks.push({ id: "key_formats", status: "ok", message: "Every stored key has the agnts_ + 64 hex format." });
    }
    return checks;
  } catch (error) {
    const { code, message } = errorCode(error);
    return [
      {
        id: "credentials_file",
        status: "fail",
        code,
        message,
        fix: code === "INSECURE_CREDENTIAL_FILE" ? "arcopolis doctor --fix-permissions" : undefined,
      },
    ];
  }
}

function checkResolution(ctx: CommandContext, resolved: ResolvedCredentials): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const read = summarizeReadKey(resolved);
  const visitor = summarizeVisitor(resolved);
  const envNames = setCredentialEnvNames(ctx.env);
  const wins: string[] = [];
  if (read.configured) wins.push(`read key from ${read.variable ?? read.source}${read.shadowsStoredKey ? " (overrides the stored key)" : ""}`);
  if (visitor.configured) {
    wins.push(`visitor key from ${visitor.variable ?? visitor.source}${visitor.shadowsStoredKey ? " (overrides the stored key)" : ""}`);
  }
  if (resolved.agentId) wins.push(`agent id from ${resolved.agentId.source}`);
  checks.push({
    id: "profile",
    status: resolved.profile.exists || read.configured || visitor.configured ? "ok" : "warn",
    message: `Profile "${resolved.profile.name}" (from ${resolved.profile.source})${resolved.profile.exists ? "" : " is not in the store"}.`,
    details: { profile: resolved.profile },
    ...(resolved.profile.exists || read.configured || visitor.configured ? {} : { fix: "arcopolis setup --json" }),
  });
  if (!read.configured && !visitor.configured) {
    checks.push({ id: "keys", status: "warn", code: "NO_CREDENTIALS", message: "No key resolves for this profile.", fix: "arcopolis setup --json" });
  } else {
    const badEnv = [read, visitor].filter((key) => key.configured && key.formatValid === false && key.variable).map((key) => key.variable);
    checks.push({
      id: "keys",
      status: badEnv.length ? "fail" : "ok",
      ...(badEnv.length ? { code: "INVALID_KEY_FORMAT" } : {}),
      message: badEnv.length ? `${badEnv.join(", ")} does not hold a well-formed key.` : `Resolved: ${wins.join("; ")}.`,
      details: { read: { configured: read.configured, source: read.source ?? null }, visitor: { configured: visitor.configured, source: visitor.source ?? null } },
    });
  }
  if (visitor.configured && !resolved.agentId) {
    checks.push({ id: "visitor_agent", status: "warn", message: "A visitor key resolves but no agent id does.", fix: "arcopolis status --json" });
  }
  const legacy = envNames.filter((name) => name.startsWith("AGNTS_"));
  checks.push({
    id: "environment",
    status: legacy.length ? "warn" : envNames.length ? "info" : "ok",
    message: envNames.length ? `Set in this environment (names only): ${envNames.join(", ")}.` : "No ARCOPOLIS_* credential variables are set.",
    ...(legacy.length ? { code: "DEPRECATED_ENV", details: { deprecated: legacy } } : {}),
  });
  return checks;
}

function checkBases(ctx: CommandContext, resolved: ResolvedCredentials | null): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  for (const plane of ["data", "control"] as const) {
    try {
      const base = plane === "data" ? ctx.store.apiBase() : ctx.store.developerBase();
      checks.push({
        id: `${plane}_base`,
        status: base.kind === "canonical" ? "ok" : "warn",
        message: `${plane === "data" ? "API" : "Developer"} base ${base.url} (${base.kind}${base.variable ? `, from ${base.variable}` : ""}).`,
      });
      if (plane === "data" && resolved) {
        for (const key of [resolved.read, resolved.visitor]) {
          if (key?.source === "store" && (base.kind === "custom" || key.origin !== base.origin)) {
            checks.push({
              id: "key_origin",
              status: "warn",
              code: "STORED_KEY_ORIGIN_MISMATCH",
              message: `A stored key was saved for ${key.origin ?? "an unknown origin"} and is never sent to ${base.origin}.`,
            });
            break;
          }
        }
      }
    } catch (error) {
      const { code, message } = errorCode(error);
      checks.push({ id: `${plane}_base`, status: "fail", code, message });
    }
  }
  return checks;
}

async function checkGitignore(gitRoot: string | null, coverage: string, missing: string[]): Promise<DoctorCheck> {
  if (!gitRoot || coverage === "no_repo") return { id: "gitignore", status: "skip", message: "Not inside a git repository." };
  let content = "";
  try {
    content = await readFile(path.join(gitRoot, ".gitignore"), "utf8");
  } catch {
    content = "";
  }
  const envFiles = (readManagedLines(content) ?? []).map((line) => line.trim()).filter((line) => line && !DEFAULT_IGNORE_ENTRIES.includes(line));
  const envMissing: string[] = [];
  for (const file of envFiles) {
    const ignored = await gitIsIgnored(gitRoot, path.join(gitRoot, file));
    if (!ignored.result) envMissing.push(file);
  }
  const all = [...missing, ...envMissing];
  if (all.length) {
    return {
      id: "gitignore",
      status: "warn",
      message: `.gitignore does not cover: ${all.join(", ")}.`,
      details: { missing: all },
      fix: "arcopolis init",
    };
  }
  return {
    id: "gitignore",
    status: "ok",
    message: `.gitignore covers ${[...DEFAULT_IGNORE_ENTRIES, ...envFiles].join(", ")}.`,
  };
}

async function checkCommittedKeys(gitRoot: string | null, cwd: string): Promise<DoctorCheck> {
  if (!gitRoot) return { id: "committed_keys", status: "skip", message: "Not inside a git repository." };
  const result = await gitGrepCommittedKeys(gitRoot);
  if (!result.repo && result.files.length === 0) {
    return { id: "committed_keys", status: "skip", message: "git grep could not run here." };
  }
  if (result.files.length) {
    const shown = result.files.slice(0, 20).map((file) => path.relative(cwd, path.join(gitRoot, file)) || file);
    return {
      id: "committed_keys",
      status: "fail",
      code: "KEY_IN_TRACKED_FILE",
      message: `${result.files.length} tracked file(s) contain an API key. Remove it, rotate the key in the portal, and treat it as leaked.`,
      details: { files: shown, truncated: result.files.length > shown.length },
      fix: "arcopolis portal",
      fixNeedsHuman: true,
    };
  }
  return { id: "committed_keys", status: "ok", message: "No API key pattern in tracked files." };
}

async function verifyStoredKey(
  ctx: CommandContext,
  resolved: ResolvedCredentials,
  kind: "read" | "visitor",
  force: boolean,
): Promise<DoctorCheck> {
  const id = kind === "read" ? "verify_read_key" : "verify_visitor_key";
  const key = kind === "read" ? resolved.read : resolved.visitor;
  if (!key) return { id, status: "skip", message: `No ${kind} key to verify.` };
  if (key.source !== "store") return { id, status: "skip", message: `The ${kind} key comes from ${key.variable ?? key.source}; doctor verifies stored keys only.` };
  const record = kind === "read" ? key.readRecord : key.visitorRecord;
  const lastVerifiedAt = record?.lastVerifiedAt ?? null;
  if (!force && lastVerifiedAt && isFresh(lastVerifiedAt, ctx.now())) {
    return { id, status: "ok", message: `The stored ${kind} key was verified ${ageText(lastVerifiedAt, ctx.now())} ago; not re-verified (use --verify).` };
  }
  try {
    const client = await ctx.createDataClient(kind, kind === "visitor" && resolved.agentId ? { agentId: resolved.agentId.value } : {});
    if (!ctx.mode.demo && client.key.value !== key.value) return { id, status: "skip", message: `The ${kind} key changed while doctor ran.` };
    await client.client.get("/", undefined, { envelope: false, purpose: "read" });
    const at = ctx.now().toISOString();
    if (!ctx.mode.demo && key.profile) await markKeyVerified(ctx, { kind, profile: key.profile, key: key.value, at });
    return { id, status: "ok", message: `The stored ${kind} key works (GET /v1).`, details: { verifiedAt: at } };
  } catch (error) {
    const { code, message } = errorCode(error);
    const auth = error instanceof CliError && error.category === "auth";
    return {
      id,
      status: "fail",
      code,
      message: `The stored ${kind} key failed verification: ${message}`,
      ...(auth ? { fix: "arcopolis setup --json" } : {}),
    };
  }
}

async function checkSignup(ctx: CommandContext): Promise<DoctorCheck> {
  try {
    const response = await ctx.createControlClient().get<Record<string, unknown>>("/signup", undefined, { purpose: "control" });
    const data = response.data ?? {};
    const worlds = data.visitorWorlds && typeof data.visitorWorlds === "object" ? (data.visitorWorlds as { open?: unknown }).open : null;
    return {
      id: "control_plane",
      status: "ok",
      message: `The developer portal answers. Visitor self-serve ${data.open === true ? "open" : "closed"}; open visitor worlds: ${typeof worlds === "number" ? worlds : "unknown"}.`,
      details: { visitorSelfServeOpen: data.open === true, visitorWorldsOpen: typeof worlds === "number" ? worlds : null },
    };
  } catch (error) {
    const { code, message } = errorCode(error);
    return { id: "control_plane", status: "fail", code, message };
  }
}

/** Runs every check. Exported for the MCP `arcopolis_doctor` tool. */
export async function runDoctor(ctx: CommandContext, options: DoctorOptions): Promise<{ data: DoctorData; next: NextStep[] }> {
  const checks: DoctorCheck[] = [];
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push({
    id: "node",
    status: major >= MIN_NODE_MAJOR ? "ok" : "fail",
    message: `Node ${process.versions.node}${major >= MIN_NODE_MAJOR ? "" : ` (Node ${MIN_NODE_MAJOR} or newer is required)`}.`,
  });
  // Permissions first, so --fix-permissions runs before anything reads the secret files.
  checks.push(await checkStorePermissions(ctx, options.fixPermissions));
  checks.push(await checkStoreLocation(ctx));
  const policy = await ctx.store.writePolicy();
  checks.push({
    id: "write_policy",
    status: "info",
    message: `writePolicy ${policy.policy}${policy.source ? ` (from ${displayPath(policy.source)})` : " (default; no config.json sets it)"}.`,
    details: { policy: policy.policy, source: policy.source ? displayPath(policy.source) : null, consulted: policy.consulted.map((entry) => ({ file: displayPath(entry.file), policy: entry.policy })) },
  });
  checks.push(...(await checkCredentialsFile(ctx)));
  let resolved: ResolvedCredentials | null = null;
  try {
    resolved = await ctx.store.resolved();
    checks.push(...checkResolution(ctx, resolved));
  } catch (error) {
    const { code, message } = errorCode(error);
    checks.push({ id: "profile", status: "fail", code, message });
  }
  checks.push(...checkBases(ctx, resolved));

  const project = await ctx.store.project();
  const inspection = await inspectProject(ctx, project);
  checks.push(await checkGitignore(inspection.gitRoot, inspection.gitignore, inspection.gitignoreMissing));
  checks.push(await checkCommittedKeys(inspection.gitRoot, ctx.cwd));

  const pending = await readPendingAction(ctx, project).catch(() => null);
  if (!pending) checks.push({ id: "pending_action", status: "ok", message: "No pending visitor action." });
  else if (pending.status === "invalid") {
    checks.push({ id: "pending_action", status: "fail", message: `${pending.file} is not a valid state file; preserve it and inspect it.` });
  } else if (pending.status === "completed") {
    checks.push({ id: "pending_action", status: "ok", message: `Last visitor action (${pending.kind ?? "unknown"}) completed.` });
  } else if (pending.replayWindowOpen) {
    checks.push({
      id: "pending_action",
      status: "warn",
      message: `A ${pending.kind ?? "visitor"} action has been pending for ${pending.ageHours ?? "?"} hours (inside the 24 h window).`,
      fix: "arcopolis visitor pending --json",
    });
  } else {
    checks.push({
      id: "pending_action",
      status: "fail",
      code: "PENDING_TOO_OLD",
      message: `A ${pending.kind ?? "visitor"} action is outside the 24 h replay window. Never resend it; resolve the outcome with the human.`,
      fix: "arcopolis visitor pending --json",
      fixNeedsHuman: true,
    });
  }
  try {
    const grant = await readPendingGrant(ctx);
    if (!grant) checks.push({ id: "pending_grant", status: "ok", message: "No pending setup approval." });
    else if (grant.expired) {
      checks.push({ id: "pending_grant", status: "warn", message: "A pending setup approval expired.", fix: "arcopolis setup --new --json" });
    } else checks.push({ id: "pending_grant", status: "info", message: `A setup approval is pending (code ${grant.userCode ?? "unknown"}).` });
  } catch (error) {
    const { code, message } = errorCode(error);
    checks.push({ id: "pending_grant", status: "fail", code, message });
  }

  const outdated = inspection.agentFiles.filter((entry) => entry.version !== BLOCK_VERSION);
  checks.push(
    inspection.agentInstructions
      ? outdated.length === 0
        ? {
            id: "agent_instructions",
            status: "ok",
            message: `Agent block ${inspection.agentInstructions} in ${inspection.agentFiles.map((entry) => entry.path).join(", ")}.`,
          }
        : {
            id: "agent_instructions",
            status: "warn",
            message: `Agent block ${outdated.map((entry) => `${entry.version} in ${entry.path}`).join(", ")} is not the current ${BLOCK_VERSION}.`,
            fix: "arcopolis init",
          }
      : { id: "agent_instructions", status: "info", message: "No Arcopolis agent block in this project.", fix: "arcopolis init" },
  );
  checks.push(
    inspection.mcp.length
      ? {
          id: "mcp_stanza",
          status: "ok",
          message: `MCP stanza in ${inspection.mcp.map((entry) => `${entry.path}${entry.allowWrites ? " (writes allowed)" : ""}`).join(", ")}.`,
        }
      : { id: "mcp_stanza", status: "info", message: "No arcopolis MCP stanza in .mcp.json or .cursor/mcp.json.", fix: "arcopolis init" },
  );

  if (options.online) {
    checks.push(await checkSignup(ctx));
    if (resolved) {
      checks.push(await verifyStoredKey(ctx, resolved, "read", options.verify));
      checks.push(await verifyStoredKey(ctx, resolved, "visitor", options.verify));
    }
  }

  const summary: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, info: 0, skip: 0 };
  for (const check of checks) summary[check.status] += 1;
  const requests = ctx.effects.requests;
  const data: DoctorData = {
    healthy: summary.fail === 0,
    online: options.online,
    summary,
    checks,
    requests,
    spentDailyBudget: false,
    message: `Doctor made ${requests} ${requests === 1 ? "request" : "requests"} and spent no daily budget.`,
  };
  const next: NextStep[] = [];
  const seen = new Set<string>();
  for (const check of checks) {
    if ((check.status !== "fail" && check.status !== "warn") || !check.fix || seen.has(check.fix)) continue;
    seen.add(check.fix);
    next.push({ command: check.fix, why: check.message, humanDecision: check.fixNeedsHuman === true });
  }
  return { data, next };
}

const MARKS: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL", info: "info", skip: "skip" };

function renderDoctorHuman(view: DocumentView): string {
  const data = view.data as DoctorData;
  const lines = data.checks.map((check) => `[${MARKS[check.status]}] ${check.message}${check.fix ? `  → ${check.fix}` : ""}`);
  lines.push("", data.healthy ? "No failing checks." : `${data.summary.fail} failing check(s).`, data.message);
  return `${lines.join("\n")}\n`;
}

export const commands: CommandSpec[] = [
  defineCommand({
    name: "doctor",
    summary: "Check the install, store permissions, project files, and (with --online) connectivity",
    description:
      "Offline by default. --online adds at most GET /_developer/signup (0 writes) and one GET /v1 per stored key not " +
      "verified in 24 hours (--verify: every stored key; about 3 reads, 3 writes, and 1 rate unit each). Never heartbeats " +
      "or reads journal, standing, or usage. Failing checks are listed in data.checks; doctor exits 0.",
    phase: 1,
    credentials: "none",
    confirmation: "none",
    network: "none by default; --online: GET /_developer/signup and GET /v1 per stale stored key",
    effects: { writes: ["credential_store"], spends: ["rateLimit"] },
    flags: [
      { name: "online", type: "boolean", description: "Also probe the control plane and verify stored keys not verified in 24 hours." },
      { name: "verify", type: "boolean", description: "With --online, verify every stored key now (about 3 reads, 3 writes, 1 rate unit each)." },
      { name: "fix-permissions", type: "boolean", description: "chmod the store directory to 0700 and files to 0600." },
    ],
    positionals: [],
    errors: ["USAGE_ERROR"],
    exitCodes: [0, 1, 2],
    outputSchema: objectSchema(
      {
        healthy: { type: "boolean" },
        online: { type: "boolean" },
        summary: { type: "object" },
        checks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: { enum: ["ok", "warn", "fail", "info", "skip"] },
              message: { type: "string" },
              code: { type: "string" },
              fix: { type: "string" },
            },
            required: ["id", "status", "message"],
          },
        },
        requests: { type: "integer" },
        spentDailyBudget: { const: false },
        message: { type: "string" },
      },
      ["healthy", "checks", "requests", "message"],
    ),
    examples: ["arcopolis doctor --json", "arcopolis doctor --online --json", "arcopolis doctor --fix-permissions"],
    async run(ctx) {
      const online = flagBoolean(ctx.flags, "online");
      const verify = flagBoolean(ctx.flags, "verify");
      if (verify && !online) throw usageError("--verify needs --online (doctor makes no requests without it).");
      return runDoctor(ctx, { online, verify, fixPermissions: flagBoolean(ctx.flags, "fix-permissions") });
    },
    renderHuman: renderDoctorHuman,
  }),
];
