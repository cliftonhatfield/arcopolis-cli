/**
 * The one-approval half of `arcopolis setup` (plan §4.2 steps 3 to 6), shared
 * by the CLI command and the MCP tools `arcopolis_setup_start` and
 * `arcopolis_setup_finish`.
 *
 * - Start: a fresh P-256 key pair and R1. The device code and private key go
 *   to `pending-grant.json` (0600) at once, so every later run resumes the
 *   same code.
 * - Wait: R2 every `interval` seconds (Retry-After on `SLOW_DOWN`), for as
 *   long as the caller allows: a terminal waits until the grant expires, an
 *   agent's first run returns the link at once (exit 10 `APPROVAL_PENDING`),
 *   and a re-run waits up to 90 seconds (hard cap 110).
 * - Approved: decrypt, validate strictly, check `--expect-email`, store at
 *   0600, record that in the pending file, ack at once, then project files,
 *   the env file, one `GET /v1` per new key, and delete the pending file.
 */
import { lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PORTAL_ORIGIN } from "../../core/bases.js";
import { displayPath, type ProfileRecord, type ReadKeyRecord, type VisitorRecord } from "../../core/credentials.js";
import { generateGrantKeyPair, jwkThumbprint } from "../../core/envelope.js";
import { CliError, type ErrorCategory } from "../../core/errors.js";
import { writeEnvFile } from "../../core/envFile.js";
import { atomicWriteFile, errno } from "../../core/files.js";
import { ensureGitignore, gitIsTracked } from "../../core/gitignore.js";
import {
  CLI_CLIENT_NAME,
  GRANT_WORLD_ID_PATTERN,
  MCP_FINISH_MAX_WAIT_SECONDS,
  NON_INTERACTIVE_MAX_WAIT_SECONDS,
  RESUME_WAIT_SECONDS,
  VISITOR_SLUG_PATTERN,
  allowedPayloadApiBases,
  clientPlatform,
  clientVersion,
  expectedEmailHash,
  grantLiveUntil,
  intentOf,
  isGrantPossiblyLive,
  isGrantsUnavailable,
  openGrantEnvelope,
  pollGrant,
  readKeyName,
  removePendingGrantFile,
  sanitizeHostLabel,
  startGrant,
  storeGrantCredentials,
  storedSummaryOf,
  waitForGrant,
  writePendingGrantFile,
  type GrantAsk,
  type GrantRequest,
  type GrantTerm,
  type PendingGrant,
  type PollResult,
} from "../../core/grant.js";
import type { HttpClient } from "../../core/http.js";
import { PROJECT_FILE, PROJECT_SCHEMA_URL, type LoadedProject } from "../../core/project.js";
import { redactKey } from "../../core/redact.js";
import type { CommandContext, DocumentResult, NextStep } from "../spec.js";
import { markKeyVerified, type VerificationResult } from "./auth.js";
import { openInBrowser } from "./portal.js";

/** Who is driving setup: the CLI command, or one of the two MCP tools. */
export type SetupMode = "cli" | "mcp_start" | "mcp_finish";

/** The flags that shape a grant (already validated by `setup`). */
export interface GrantSetupInput {
  /** Explicit `--wait` in seconds, if given. */
  wait: number | undefined;
  noBrowser: boolean;
  verify: boolean;
  /** `--write-env-file` as given (relative to cwd). */
  envFile: string | undefined;
  expectEmail: string | null;
}

/** Terms the page will show (plan §2.8). */
export const DEVELOPER_TERMS = { name: "Developer/API Terms", version: "2026-07-20" } as const;
export const VISITOR_CORPUS_TERMS = { name: "Visitor research-corpus terms", version: "2026-09-16" } as const;

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

/** Default visitor slug for an app name: the slugified name, kept inside the backend slug rule. */
export function defaultVisitorSlug(slug: string): string {
  if (VISITOR_SLUG_PATTERN.test(slug)) return slug;
  const padded = `visitor-${slug}`.slice(0, 32).replace(/-+$/g, "");
  return VISITOR_SLUG_PATTERN.test(padded) ? padded : "visitor";
}

/** The grant request for this run (intent plus host label). */
export function buildGrantRequest(input: {
  app: string;
  installId: string;
  readTier: 1 | 2 | 3 | null;
  visitor: { slug: string; worldId: string | null } | null;
  label: string | undefined;
  noLabel: boolean;
}): GrantRequest {
  if (input.visitor?.worldId !== null && input.visitor?.worldId !== undefined && !GRANT_WORLD_ID_PATTERN.test(input.visitor.worldId)) {
    throw new CliError("INVALID_FLAG_VALUE", "--world must match ^[A-Za-z0-9_-]{1,128}$ for a setup approval.", { humanDecision: false });
  }
  return {
    app: input.app,
    readKey: input.readTier === null ? null : { name: readKeyName(input.app, input.installId), tier: input.readTier },
    visitor: input.visitor,
    hostLabel: input.noLabel ? null : sanitizeHostLabel(input.label ?? os.hostname()),
  };
}

/** Terms the human will see for a request. */
export function termsFor(request: GrantRequest, visitorTermsVersion: string): GrantTerm[] {
  const terms: GrantTerm[] = [{ name: DEVELOPER_TERMS.name, version: DEVELOPER_TERMS.version }];
  if (request.visitor) terms.push({ name: VISITOR_CORPUS_TERMS.name, version: visitorTermsVersion });
  return terms;
}

// ---------------------------------------------------------------------------
// Errors and the humanAction block
// ---------------------------------------------------------------------------

/** Resume command for `next`: the CLI re-run, or the MCP finish tool. */
function resumeStep(mode: SetupMode): NextStep {
  return mode === "cli"
    ? { command: "arcopolis setup --json", why: "Re-run after the human approves; it resumes the same code and waits up to 90 seconds", humanDecision: false }
    : { command: "arcopolis_setup_finish", why: "Call after the human says they approved; it resumes the same code and waits up to 30 seconds", humanDecision: false };
}

function newGrantStep(mode: SetupMode, why: string): NextStep {
  return mode === "cli"
    ? { command: "arcopolis setup --new --json", why, humanDecision: true }
    : { command: 'arcopolis_setup_start {"new":true}', why, humanDecision: true };
}

/** `humanAction` for a pending grant (plan §4.2 non-TTY example). */
export function humanActionFor(pending: PendingGrant, now: Date): Record<string, unknown> {
  const expiresInSeconds = Math.max(0, Math.round((Date.parse(pending.expiresAt) - now.getTime()) / 1000));
  const request = pending.request;
  const account = pending.expectedEmail ? ` as ${pending.expectedEmail}` : "";
  return {
    verificationUriComplete: pending.verificationUriComplete,
    verificationUri: pending.verificationUri,
    userCode: pending.userCode,
    expiresInSeconds,
    requested: {
      app: request.app,
      readKey: request.readKey ? { tier: request.readKey.tier } : null,
      visitor: request.visitor ? { slug: request.visitor.slug, worldId: request.visitor.worldId } : null,
    },
    termsTheHumanWillSee: pending.terms.map((term) => ({ name: term.name, version: term.version })),
    tellTheHuman:
      `Open ${pending.verificationUriComplete} on any device, sign in with Google${account}, check the code is ${pending.userCode}, ` +
      "and approve. Then tell me.",
  };
}

/** Exit 10 `APPROVAL_PENDING` with the link and code. */
export function approvalPending(ctx: CommandContext, pending: PendingGrant, options: { resumed: boolean; status: "pending" | "claimed" | null; mode: SetupMode }): CliError {
  return new CliError("APPROVAL_PENDING", "A person must approve this once in a browser.", {
    surface: "local",
    humanDecision: true,
    hint: "Give the human the link and code exactly. Do not open it, approve it, or accept terms yourself.",
    humanAction: humanActionFor(pending, ctx.now()),
    details: { resumed: options.resumed, status: options.status, expiresAt: pending.expiresAt },
    next: [resumeStep(options.mode)],
  });
}

export function grantNotStarted(mode: SetupMode): CliError {
  return new CliError("GRANT_NOT_STARTED", "There is no pending setup approval to resume.", {
    humanDecision: false,
    hint: mode === "cli" ? "Run arcopolis setup --json to start one." : "Call arcopolis_setup_start first.",
    next: [
      mode === "cli"
        ? { command: "arcopolis setup --json", why: "Start a setup approval", humanDecision: false }
        : { command: "arcopolis_setup_start", why: "Start a setup approval", humanDecision: false },
    ],
  });
}

export function grantExpired(mode: SetupMode, userCode: string): CliError {
  return new CliError("CLI_GRANT_EXPIRED", `The approval code ${userCode} expired before it was approved. Nothing was stored.`, {
    surface: "control",
    humanDecision: true,
    hint: "Tell the human. Start a new code only when they are ready to approve it.",
    details: { userCode },
    next: [newGrantStep(mode, "Get a new code (the human approves it once)")],
  });
}

function approvalDenied(mode: SetupMode, userCode: string): CliError {
  return new CliError("APPROVAL_DENIED", `The human denied setup request ${userCode} on the approval page. Nothing was created.`, {
    surface: "control",
    humanDecision: true,
    hint: "Tell the human. Do not start a new request unless they ask for one.",
    details: { userCode },
    next: [newGrantStep(mode, "Only if the human asks to try again")],
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/** Everything needed to start one grant. */
export interface StartGrantInput {
  request: GrantRequest;
  profile: string;
  expectedEmail: string | null;
  envFile: string | null;
  terms: GrantTerm[];
  /** What the run asked for before narrowing (compared by later runs). */
  asked: GrantAsk;
}

/**
 * R1 and the pending file. Returns null when grants are unavailable here
 * (401, 404, or 503 `CLI_GRANTS_DISABLED` / `DEVELOPER_PORTAL_DISABLED`), so
 * the caller falls back to the guided setup.
 */
export async function startPendingGrant(ctx: CommandContext, input: StartGrantInput): Promise<PendingGrant | null> {
  const developerBase = ctx.store.developerBase();
  const { publicKey, privateKey } = await generateGrantKeyPair();
  const client = ctx.createControlClient();
  let started;
  try {
    started = await startGrant(
      client,
      {
        client: {
          name: CLI_CLIENT_NAME,
          version: clientVersion(ctx.version),
          platform: clientPlatform(ctx.runtime?.platform ?? process.platform),
          hostLabel: input.request.hostLabel,
        },
        publicKey,
        intent: intentOf(input.request),
        expectedEmailSha256: input.expectedEmail ? expectedEmailHash(input.expectedEmail) : null,
      },
      developerBase.kind === "canonical" ? PORTAL_ORIGIN : null,
    );
  } catch (error) {
    if (isGrantsUnavailable(error)) {
      const code = error instanceof CliError ? error.code : "UNAVAILABLE";
      ctx.warnings.add("CLI_GRANTS_UNAVAILABLE", `One-approval setup is not available right now (${code}); using the guided setup.`);
      return null;
    }
    throw error;
  }
  ctx.effects.write("cli_grant");
  const pending: PendingGrant = {
    schemaVersion: 1,
    userCode: started.userCode,
    deviceCode: started.deviceCode,
    privateKeyJwk: privateKey,
    publicKeyThumbprint: jwkThumbprint(publicKey),
    expiresAt: started.expiresAt,
    interval: started.interval,
    profile: input.profile,
    envFile: input.envFile,
    request: input.request,
    expectedEmail: input.expectedEmail,
    // Server clock, like expiresAt, so the liveness bound does not depend on local skew.
    createdAt: new Date(Date.parse(started.expiresAt) - started.expiresIn * 1000).toISOString(),
    verificationUri: started.verificationUri,
    verificationUriComplete: started.verificationUriComplete,
    developerBase: developerBase.url,
    terms: input.terms,
    asked: input.asked,
    stored: null,
  };
  await writePendingGrantFile(ctx.store.credentialStore, pending);
  return pending;
}

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long this run polls (ms). */
export function waitBudgetMs(ctx: CommandContext, pending: PendingGrant, input: GrantSetupInput, options: { mode: SetupMode; resumed: boolean }): number {
  const now = ctx.now().getTime();
  if (options.mode === "mcp_finish") return Math.min(input.wait ?? MCP_FINISH_MAX_WAIT_SECONDS, MCP_FINISH_MAX_WAIT_SECONDS) * 1000;
  if (options.mode === "mcp_start") return 0;
  if (ctx.mode.interactive) {
    const untilExpiry = Math.max(0, grantLiveUntil(pending) - now);
    return input.wait === undefined ? untilExpiry : Math.min(input.wait * 1000, untilExpiry);
  }
  const seconds = input.wait ?? (options.resumed ? RESUME_WAIT_SECONDS : 0);
  return Math.min(seconds, NON_INTERACTIVE_MAX_WAIT_SECONDS) * 1000;
}

/** Local time for a terminal (`11:59 PM CDT`). */
function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

function describeRequest(request: GrantRequest): string {
  const parts = [`app "${request.app}"`];
  if (request.readKey) parts.push(`1 read key (tier ${request.readKey.tier})`);
  if (request.visitor) parts.push(`1 visitor ("visitor-${request.visitor.slug}"${request.visitor.worldId ? ` in ${request.visitor.worldId}` : ""})`);
  return parts.join(" · ");
}

/** The terminal banner (stderr): plan, link, code, expiry. Never printed without a TTY. */
async function printBanner(ctx: CommandContext, pending: PendingGrant, input: GrantSetupInput, resumed: boolean): Promise<void> {
  const out = (line: string): void => ctx.io.stderr.write(`${line}\n`);
  let opened = false;
  if (!resumed && !input.noBrowser && !ctx.mode.demo && !ctx.mode.mcp) {
    const open = ctx.runtime?.openUrl ?? ((url: string): Promise<boolean> => openInBrowser(url, ctx.runtime?.platform));
    opened = await open(pending.verificationUriComplete).catch(() => false);
  }
  out(resumed ? "Arcopolis setup (resuming the pending approval)" : "Arcopolis setup");
  out(`  Plan: ${describeRequest(pending.request)}`);
  const terms = pending.terms.map((term) => `the ${term.name} (${term.version})`).join(" and ");
  out(`  Nothing is created until you approve. You will be asked to accept ${terms}.`);
  out("");
  out(`  Open  ${pending.verificationUriComplete}${opened ? "   (opened in your browser)" : ""}`);
  out(`  Code  ${pending.userCode}   expires ${localTime(pending.expiresAt)}`);
  out("");
  ctx.io.stderr.write("Waiting for approval...");
}

/**
 * Polls within the budget and handles every terminal status. Returns the
 * setup result on success; throws exit 10 (pending or denied), 13
 * (expired), or the approval's own failure.
 */
export async function awaitGrant(
  ctx: CommandContext,
  pending: PendingGrant,
  input: GrantSetupInput,
  options: { mode: SetupMode; resumed: boolean },
): Promise<DocumentResult<GrantSetupData>> {
  if (pending.developerBase !== ctx.store.developerBase().url) {
    throw new CliError("GRANT_BASE_MISMATCH", "The pending approval was started on another control plane; its code is never sent anywhere else.", {
      humanDecision: true,
      hint: "Restore ARCOPOLIS_DEVELOPER_BASE, or run arcopolis setup --new --json to start over.",
      details: { userCode: pending.userCode },
    });
  }
  const client = ctx.createControlClient();
  const interactive = ctx.mode.interactive && options.mode === "cli";
  const waitMs = waitBudgetMs(ctx, pending, input, options);
  if (interactive) await printBanner(ctx, pending, input, options.resumed);
  let claimedShown = false;
  let result: PollResult;
  try {
    result = await waitForGrant({
      client,
      grant: pending,
      waitMs,
      now: ctx.now,
      sleep: ctx.runtime?.sleep ?? defaultSleep,
      onPoll: (poll) => {
        if (interactive && poll.status === "claimed" && !claimedShown) {
          claimedShown = true;
          ctx.io.stderr.write(" the approver has the page open...");
        }
      },
    });
  } catch (error) {
    if (interactive) ctx.io.stderr.write("\n");
    if (error instanceof CliError && error.code === "CLI_GRANT_NOT_FOUND") {
      // Keys stored before a crash are finished, never reported as lost.
      if (pending.stored) return finishStored(ctx, pending, input, { acked: false });
      await removePendingGrantFile(ctx.store.credentialStore);
      throw new CliError(error.code, `The server no longer knows approval code ${pending.userCode}. Nothing was stored.`, {
        httpStatus: error.httpStatus,
        surface: "control",
        humanDecision: true,
        hint: "Tell the human; start a new code only when they are ready.",
        next: [newGrantStep(options.mode, "Get a new code (the human approves it once)")],
      });
    }
    throw error;
  }
  if (interactive) ctx.io.stderr.write(result.status === "approved" ? " approved.\n" : "\n");
  switch (result.status) {
    case "pending":
    case "claimed": {
      if (result.expiresAt && result.expiresAt !== pending.expiresAt) {
        pending.expiresAt = result.expiresAt;
        await writePendingGrantFile(ctx.store.credentialStore, pending);
      }
      throw approvalPending(ctx, pending, { resumed: options.resumed, status: result.status, mode: options.mode });
    }
    case "approved":
      return completeApproved(ctx, client, pending, result, input, options.mode);
    case "consumed":
      if (pending.stored) return finishStored(ctx, pending, input, { acked: true });
      await removePendingGrantFile(ctx.store.credentialStore);
      throw new CliError("CLI_GRANT_NOT_PENDING", `Approval ${pending.userCode} was already used, and this terminal holds no keys from it.`, {
        surface: "control",
        humanDecision: true,
        hint: "Tell the human. The keys it made are in the developer portal; start a new code only when they are ready.",
        next: [newGrantStep(options.mode, "Get a new code (the human approves it once)")],
      });
    case "denied":
      await removePendingGrantFile(ctx.store.credentialStore);
      throw approvalDenied(options.mode, pending.userCode);
    case "expired":
      if (pending.stored) return finishStored(ctx, pending, input, { acked: false });
      await removePendingGrantFile(ctx.store.credentialStore);
      throw grantExpired(options.mode, pending.userCode);
  }
}

/**
 * Before a run replaces a pending grant that asked for something else, it
 * checks what became of that grant, so an approval is never thrown away
 * unread. Returns null when the grant may be replaced (still pending,
 * denied, expired, consumed, or unknown to the server). Keys already stored
 * or an approval waiting to be collected are finished instead, and a grant
 * whose page the human has open is refused (exit 10) rather than replaced.
 */
export async function settleBeforeReplace(
  ctx: CommandContext,
  pending: PendingGrant,
  input: GrantSetupInput,
  options: { mode: SetupMode; conflict: string },
): Promise<DocumentResult<GrantSetupData> | null> {
  const finishing = (): void =>
    ctx.warnings.add(
      "PENDING_GRANT_FINISHED",
      `The pending approval ${pending.userCode} was already approved, so this run finished it instead of starting a new request (${options.conflict}). Run setup again for the rest.`,
    );
  if (pending.stored) {
    finishing();
    return finishStored(ctx, pending, input, { acked: false });
  }
  if (!isGrantPossiblyLive(pending, ctx.now()) || pending.developerBase !== ctx.store.developerBase().url) return null;
  const client = ctx.createControlClient();
  let result: PollResult;
  try {
    result = await pollGrant(client, pending);
  } catch (error) {
    if (error instanceof CliError && error.code === "CLI_GRANT_NOT_FOUND") return null;
    throw error;
  }
  switch (result.status) {
    case "pending":
    case "denied":
    case "expired":
    case "consumed":
      return null;
    case "claimed":
      throw new CliError(
        "APPROVAL_PENDING",
        `The human has the approval page for code ${pending.userCode} open, and it asks for something else (${options.conflict}). A new code is not started while it is open.`,
        {
          surface: "local",
          humanDecision: true,
          hint: "Ask the human to finish that approval (then re-run to collect it), or to close the page; start a new code only after that.",
          humanAction: humanActionFor(pending, ctx.now()),
          details: { resumed: true, status: "claimed", conflict: options.conflict, expiresAt: pending.expiresAt },
          next: [resumeStep(options.mode), newGrantStep(options.mode, `Only after the human closed the page without approving; this discards code ${pending.userCode}`)],
        },
      );
    case "approved":
      finishing();
      return completeApproved(ctx, client, pending, result, input, options.mode);
  }
}

// ---------------------------------------------------------------------------
// Approved
// ---------------------------------------------------------------------------

/** One stored key as `setup` reports it. */
export interface GrantKeyData {
  id: string | null;
  keyPrefix: string;
  action: string;
  verified: boolean;
  verification: VerificationResult;
}

/** `data` of a successful grant setup (plan §4.2 exit-0 example). */
export interface GrantSetupData {
  profile: string;
  mode: "grant";
  approvedBy: string | null;
  store: string;
  userCode: string;
  app: { id: string; name: string; created: boolean };
  readKey: (GrantKeyData & { tier: number | null; name: string | null }) | null;
  visitor: (GrantKeyData & { agentId: string; handle: string | null; worldId: string | null; keyId: string | null; driveDailyBudget: number | null }) | null;
  terms: { developer: string; visitorCorpus: string | null };
  files: string[];
}

async function ackGrant(ctx: CommandContext, client: HttpClient, pending: PendingGrant): Promise<boolean> {
  try {
    const acked = await pollGrant(client, pending, true);
    if (acked.status === "consumed") return true;
    ctx.warnings.add("GRANT_ACK_UNCONFIRMED", `The server answered the receipt with status ${acked.status}; the keys are stored.`);
  } catch (error) {
    const code = error instanceof CliError ? error.code : "INTERNAL";
    ctx.warnings.add(
      "GRANT_ACK_FAILED",
      `The keys are stored, but the receipt was not confirmed (${code}). The server deletes its encrypted copy when the approval expires.`,
    );
  }
  return false;
}

async function completeApproved(
  ctx: CommandContext,
  client: HttpClient,
  pending: PendingGrant,
  result: Extract<PollResult, { status: "approved" }>,
  input: GrantSetupInput,
  mode: SetupMode,
): Promise<DocumentResult<GrantSetupData>> {
  // 1. Decrypt and validate. A failure stores nothing and sends no ack.
  const payload = await openGrantEnvelope(result.envelope, pending, {
    allowedApiBases: allowedPayloadApiBases(ctx.store.apiBase()),
    resultSummary: result.resultSummary,
  });
  // 2. The approving account must be the expected one.
  const expected = pending.expectedEmail ?? input.expectEmail;
  const approver = payload.account.email?.trim().toLowerCase() ?? null;
  if (expected && approver !== expected) {
    await ackGrant(ctx, client, pending);
    await removePendingGrantFile(ctx.store.credentialStore);
    throw new CliError(
      "APPROVER_MISMATCH",
      `The approval came from ${payload.account.email ?? "an account with no email address"}, not ${expected}. Nothing was stored.`,
      {
        surface: "local",
        humanDecision: true,
        hint: "Tell the human which account approved. The keys that approval made are in that account's developer portal; delete them there if they were not meant.",
        details: { expectedEmail: expected, approvedBy: payload.account.email, userCode: pending.userCode },
        next: [newGrantStep(mode, "Only after the human confirms which account to use")],
      },
    );
  }
  // 3. Store at 0600 before the ack, and record that in the pending file.
  const savedAt = ctx.now().toISOString();
  await storeGrantCredentials(ctx.store.credentialStore, { profile: pending.profile, payload, developerBase: pending.developerBase, savedAt });
  ctx.effects.write("credential_store");
  if (payload.readKey) ctx.effects.secretWritten("credential_store:readKey");
  if (payload.visitor) ctx.effects.secretWritten("credential_store:visitorKey");
  pending.stored = storedSummaryOf(payload, savedAt);
  await writePendingGrantFile(ctx.store.credentialStore, pending);
  // 4. Ack at once: the server deletes the envelope.
  const acked = await ackGrant(ctx, client, pending);
  for (const warning of payload.warnings) ctx.warnings.add("GRANT_WARNING", warning);
  return finishStored(ctx, pending, input, { acked });
}

// ---------------------------------------------------------------------------
// After the store: project files, env file, verification, cleanup
// ---------------------------------------------------------------------------

/**
 * `arcopolis.json` (created only when missing) and the `.gitignore` block,
 * inside a git work tree only.
 */
async function writeProjectFiles(ctx: CommandContext, project: LoadedProject, profile: string, visitorAgentId: string | null): Promise<string[]> {
  if (ctx.mode.demo || !project.gitRoot) return [];
  const files: string[] = [];
  const gitignore = await ensureGitignore(project.gitRoot);
  if (gitignore.action !== "unchanged") files.push(relative(ctx.cwd, gitignore.path));
  if (!project.file) {
    const target = path.join(project.root, PROJECT_FILE);
    const skeleton = { $schema: PROJECT_SCHEMA_URL, schemaVersion: 1, profile };
    await atomicWriteFile(target, `${JSON.stringify(skeleton, null, 2)}\n`, 0o644);
    files.push(relative(ctx.cwd, target));
  } else if (visitorAgentId && project.config.visitor?.agentId && project.config.visitor.agentId !== visitorAgentId) {
    ctx.warnings.add(
      "PROJECT_AGENT_ID_DIFFERS",
      `${PROJECT_FILE} names visitor ${project.config.visitor.agentId}, which wins over the new visitor ${visitorAgentId}; update or remove visitor.agentId there.`,
    );
  }
  if (files.length) ctx.effects.write("project_files");
  return files;
}

function relative(cwd: string, target: string): string {
  const rel = path.relative(cwd, target);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : target;
}

/**
 * Refuses an env file path that can never hold keys (a symbolic link or a
 * file git tracks) before anything is asked of the human.
 */
export async function precheckEnvFile(ctx: CommandContext, file: string): Promise<void> {
  const target = path.resolve(ctx.cwd, file);
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new CliError("INVALID_PATH", `${file} is a symbolic link; keys are never written through one.`, { humanDecision: true });
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (errno(error) !== "ENOENT") throw error;
  }
  const project = await ctx.store.project();
  if (!project.gitRoot) return;
  const tracked = await gitIsTracked(project.gitRoot, target);
  if (tracked.result) {
    throw new CliError("ENV_FILE_TRACKED", `${file} is tracked by git; refusing to write secrets into it.`, {
      hint: "Choose an untracked path such as .env.arcopolis, or remove the file from git first.",
      humanDecision: true,
    });
  }
}

async function writeGrantEnvFile(ctx: CommandContext, file: string, profile: ProfileRecord): Promise<string[]> {
  const apiBase = profile.apiBase ?? ctx.store.apiBase().url;
  const origin = new URL(apiBase).origin;
  const vars: Record<string, string> = { ARCOPOLIS_API_BASE: apiBase };
  if (profile.readKey?.key && profile.readKey.origin === origin) vars.ARCOPOLIS_API_KEY = profile.readKey.key;
  if (profile.visitor?.key && profile.visitor.origin === origin) {
    vars.ARCOPOLIS_VISITOR_API_KEY = profile.visitor.key;
    vars.ARCOPOLIS_VISITOR_AGENT_ID = profile.visitor.agentId;
  }
  const project = await ctx.store.project();
  const result = await writeEnvFile({
    root: project.gitRoot ?? ctx.cwd,
    file: path.resolve(ctx.cwd, file),
    vars,
    confirmGitignore: async (rel: string): Promise<boolean> => {
      if (!ctx.mode.interactive) {
        // --write-env-file is the request; ignoring the file first only protects it.
        ctx.warnings.add("ENV_FILE_IGNORED", `${rel} was added to the .gitignore managed block before the keys were written.`);
        return true;
      }
      const yes = await ctx.confirm(`${rel} is not ignored by git. Add it to .gitignore and write the keys?`);
      if (!yes) throw new CliError("CONFIRMATION_DECLINED", `${rel} was not written; the keys are in the store.`, { humanDecision: true });
      return true;
    },
  });
  const files: string[] = [];
  if (result.action !== "unchanged") {
    ctx.effects.write("env_file");
    for (const variable of result.variables) if (/_KEY$/.test(variable.name)) ctx.effects.secretWritten(`env_file:${variable.name}`);
  }
  files.push(relative(ctx.cwd, result.path));
  if (result.gitignore && result.gitignore.action !== "unchanged") {
    ctx.effects.write("project_files");
    files.push(relative(ctx.cwd, result.gitignore.path));
  }
  return files;
}

/**
 * One `GET /v1` with a key just stored, through the resolved data client so
 * the key goes only to its own origin. A failure never removes the key (the
 * approval was already consumed); it is reported as unverified.
 */
async function verifyGrantKey(ctx: CommandContext, kind: "read" | "visitor", profile: string, record: ReadKeyRecord | VisitorRecord): Promise<VerificationResult> {
  const base = ctx.store.apiBase();
  if (base.kind === "custom" || record.origin !== base.origin) {
    ctx.warnings.add("KEY_NOT_VERIFIED", `The ${kind} key was saved for ${record.origin} and this CLI is pointed at ${base.origin}; it was not verified.`);
    return { verified: false, skipped: "origin_mismatch" };
  }
  ctx.store.invalidate();
  let client: Awaited<ReturnType<CommandContext["createDataClient"]>>;
  try {
    client = await ctx.createDataClient(kind, kind === "visitor" ? { agentId: (record as VisitorRecord).agentId } : {});
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "NO_CREDENTIALS") throw error;
    ctx.warnings.add("KEY_NOT_VERIFIED", `The ${kind} key was saved but not verified in this run.`);
    return { verified: false, skipped: "resolution_cached" };
  }
  if (client.key.value !== record.key) {
    const envOverride = client.key.source === "env" || client.key.source === "legacy_env";
    ctx.warnings.add(
      "KEY_NOT_VERIFIED",
      envOverride
        ? `The ${kind} key was saved but not verified: ${client.key.variable ?? "an environment variable"} overrides it in this session.`
        : `The ${kind} key was saved to profile ${profile} but another profile is active here; it was not verified.`,
    );
    return envOverride ? { verified: false, skipped: "env_override", variable: client.key.variable ?? null } : { verified: false, skipped: "other_profile" };
  }
  try {
    await client.client.get("/", undefined, { envelope: false, purpose: "read" });
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    ctx.warnings.add("KEY_NOT_VERIFIED", `The ${kind} key was saved but GET /v1 failed (${error.code}). Run arcopolis doctor --online --verify later.`);
    const category: ErrorCategory = error.category;
    return { verified: false, error: { code: error.code, category, exitCode: error.exitCode } };
  }
  const at = ctx.now().toISOString();
  await markKeyVerified(ctx, { kind, profile, key: record.key, at });
  return { verified: true, verifiedAt: at };
}

/**
 * Everything after the keys are safely stored: project files, the env file,
 * verification, then the pending file is deleted. Also finishes a run that
 * crashed after the store (the pending file says what was stored).
 */
export async function finishStored(
  ctx: CommandContext,
  pending: PendingGrant,
  input: GrantSetupInput,
  options: { acked: boolean },
): Promise<DocumentResult<GrantSetupData>> {
  const stored = pending.stored;
  if (!stored) throw new CliError("INTERNAL", "finishStored needs a stored grant.");
  const credentials = await ctx.store.credentialStore.readCredentials();
  const profile = credentials.profiles[pending.profile];
  const readRecord = stored.readKey && profile?.readKey?.id === stored.readKey.id ? profile.readKey : null;
  const visitorRecord = stored.visitor && profile?.visitor?.keyId === stored.visitor.keyId ? profile.visitor : null;
  if ((stored.readKey && !readRecord) || (stored.visitor && !visitorRecord)) {
    ctx.warnings.add("GRANT_STORE_CHANGED", `Profile ${pending.profile} changed after the approval was stored; reporting what it holds now.`);
  }
  const project = await ctx.store.project();
  const files = await writeProjectFiles(ctx, project, pending.profile, visitorRecord?.agentId ?? null);
  const envFile = input.envFile ?? pending.envFile;
  if (envFile && profile) files.push(...(await writeGrantEnvFile(ctx, envFile, profile)));
  const skipped: VerificationResult = { verified: false, skipped: "no_verify" };
  const readVerification = readRecord ? (input.verify ? await verifyGrantKey(ctx, "read", pending.profile, readRecord) : skipped) : null;
  const visitorVerification = visitorRecord ? (input.verify ? await verifyGrantKey(ctx, "visitor", pending.profile, visitorRecord) : skipped) : null;
  await removePendingGrantFile(ctx.store.credentialStore);
  if (!options.acked) ctx.warnings.add("GRANT_NOT_ACKNOWLEDGED", "The approval was not acknowledged; it expires on its own. Nothing else is needed.");
  const data: GrantSetupData = {
    profile: pending.profile,
    mode: "grant",
    approvedBy: stored.account.email,
    store: displayPath(ctx.store.paths.credentialsFile),
    userCode: pending.userCode,
    app: { ...stored.app },
    readKey:
      readRecord && readVerification && stored.readKey
        ? {
            id: readRecord.id ?? null,
            keyPrefix: redactKey(readRecord.key),
            tier: readRecord.tier ?? null,
            name: readRecord.name ?? null,
            action: stored.readKey.action,
            verified: readVerification.verified,
            verification: readVerification,
          }
        : null,
    visitor:
      visitorRecord && visitorVerification && stored.visitor
        ? {
            id: visitorRecord.keyId ?? null,
            agentId: visitorRecord.agentId,
            handle: visitorRecord.handle ?? null,
            worldId: visitorRecord.worldId ?? null,
            keyId: visitorRecord.keyId ?? null,
            keyPrefix: redactKey(visitorRecord.key),
            driveDailyBudget: visitorRecord.driveDailyBudget ?? null,
            action: stored.visitor.action,
            verified: visitorVerification.verified,
            verification: visitorVerification,
          }
        : null,
    terms: { ...stored.terms },
    files: [...new Set(files)],
  };
  return { data, next: grantSuccessNext(data) };
}

function grantSuccessNext(data: GrantSetupData): NextStep[] {
  const next: NextStep[] = [];
  if (data.readKey) {
    next.push({ command: "arcopolis agents list --per-page 5 --json", why: "First read", humanDecision: false });
    next.push({ command: "arcopolis exec -- node app.mjs", why: "Run your own program with ARCOPOLIS_API_KEY injected (replace `node app.mjs` with its command)", humanDecision: false });
  }
  if (data.visitor) next.push({ command: "arcopolis visitor status --json", why: "Cached visitor state (no network)", humanDecision: false });
  return next;
}

/** Human text for a grant success (stdout). */
export function renderGrantHuman(data: GrantSetupData, next: NextStep[]): string {
  const lines = [`Approved by ${data.approvedBy ?? "an account with no email address"} (code ${data.userCode})`];
  lines.push(`  App       ${data.app.name} (${data.app.created ? "created" : "existing"})`);
  const verified = (key: GrantKeyData): string => (key.verified ? "verified (GET /v1 ok)" : `not verified${key.verification.skipped ? ` (${key.verification.skipped})` : ""}`);
  if (data.readKey) {
    lines.push(`  Read key  ${data.readKey.keyPrefix}  tier ${data.readKey.tier ?? "?"}, ${data.readKey.action}, saved to ${data.store} (0600), ${verified(data.readKey)}`);
  }
  if (data.visitor) {
    lines.push(`  Visitor   @${data.visitor.handle ?? data.visitor.agentId} ${data.visitor.keyPrefix}  ${data.visitor.action}, ${verified(data.visitor)}`);
  }
  if (data.files.length) lines.push(`  Files     ${data.files.join(", ")}`);
  const first = next[0];
  if (first) lines.push(`Next: ${first.command}`);
  return `${lines.join("\n")}\n`;
}

