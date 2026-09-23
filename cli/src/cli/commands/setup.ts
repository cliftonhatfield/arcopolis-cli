/**
 * `arcopolis setup` (plan §4.2): credentials with one human approval.
 *
 * 1. Offline preflight: Node version, bases, store modes. A pending approval
 *    (`pending-grant.json`) that may still be live and that this run does not
 *    contradict is resumed first, so the human only ever sees one code. When
 *    every requested key already resolves (environment, or stored and
 *    verified in the last 24 hours) and there is no `--force`, it exits 0
 *    with no request.
 * 2. `GET /_developer/signup` (no auth, 0 writes): 503 portal disabled exits
 *    8; with no open visitor world a visitor-only request exits 8
 *    `NO_VISITOR_WORLD_OPEN`, otherwise the visitor is dropped with a warning.
 * 3. The grant (see `setupGrant.ts`): R1, then without a TTY exit 10
 *    `APPROVAL_PENDING` with `humanAction` (the re-run waits up to 90 s); in a
 *    TTY print the link and code, open the browser, and poll until approved.
 *    On approval the keys are decrypted, validated, stored at 0600, and the
 *    grant is acknowledged, then each new key gets one `GET /v1`.
 * 4. When R1 answers 401, 404, or 503 `CLI_GRANTS_DISABLED` /
 *    `DEVELOPER_PORTAL_DISABLED` (or the signup probe could not reach the
 *    control plane at all), the guided fallback (plan step 7): a TTY
 *    prints the portal link and imports the key from a hidden prompt; without
 *    a TTY it exits 10 `HUMAN_SETUP_REQUIRED` with `humanAction` steps. So
 *    this version is safe before the grant routes are armed.
 *
 * The CLI never accepts terms: the human does, on the approval page.
 */
import { access, constants as fsConstants } from "node:fs/promises";
import path from "node:path";
import { displayPath, resolveCredentials, type ResolvedCredentials, type ResolvedKey } from "../../core/credentials.js";
import { CliError } from "../../core/errors.js";
import { writeEnvFile } from "../../core/envFile.js";
import {
  VISITOR_SLUG_PATTERN,
  isGrantPossiblyLive,
  isPlausibleEmail,
  isPrintableName,
  readPendingGrantFile,
  removePendingGrantFile,
  sanitizeHostLabel,
  type PendingGrant,
} from "../../core/grant.js";
import { findGitRoot } from "../../core/project.js";
import { redactKey } from "../../core/redact.js";
import {
  defineCommand,
  flagBoolean,
  flagNumber,
  flagString,
  objectSchema,
  usageError,
  type CommandContext,
  type CommandSpec,
  type DocumentResult,
  type DocumentView,
  type NextStep,
} from "../spec.js";
import {
  assertAgentId,
  assertKeyFormat,
  markKeyVerified,
  resolveImportProfile,
  storeImportedKey,
  verifyImportedKey,
  type ImportKind,
  type StoredImport,
  type VerificationResult,
} from "./auth.js";
import { assertKeysMatchBase } from "./env.js";
import { PORTAL_AGENT_URL, PORTAL_READ_URL } from "./portal.js";
import {
  DEVELOPER_TERMS,
  VISITOR_CORPUS_TERMS,
  approvalPending,
  awaitGrant,
  finishStored,
  buildGrantRequest,
  defaultVisitorSlug,
  grantExpired,
  grantNotStarted,
  humanActionFor,
  precheckEnvFile,
  renderGrantHuman,
  settleBeforeReplace,
  startPendingGrant,
  termsFor,
  type GrantSetupData,
  type GrantSetupInput,
  type SetupMode,
} from "./setupGrant.js";
import { isFresh } from "./status.js";

export { DEVELOPER_TERMS, VISITOR_CORPUS_TERMS } from "./setupGrant.js";
export type { SetupMode } from "./setupGrant.js";

/** Flags only the approval grant uses; the guided fallback reports them as ignored. */
const GRANT_ONLY_FLAGS = ["label", "no-label", "expect-email", "wait", "no-browser"] as const;

/** Environment variables the human sets in the agent platform's secret settings. */
const ENV_FOR: Record<ImportKind, Array<{ name: string; secret: boolean; holds: string }>> = {
  read: [{ name: "ARCOPOLIS_API_KEY", secret: true, holds: "the read key" }],
  visitor: [
    { name: "ARCOPOLIS_VISITOR_API_KEY", secret: true, holds: "the visitor drive key" },
    { name: "ARCOPOLIS_VISITOR_AGENT_ID", secret: false, holds: "the visitor agent id" },
  ],
};

type KeyState = "missing" | "env" | "fresh" | "stale" | "verified" | "unverified";

interface SetupKeyData {
  keyPrefix: string;
  action: "existing" | "imported";
  source: string;
  variable?: string;
  tier?: number | null;
  agentId?: string | null;
  lastVerifiedAt?: string | null;
  verified: boolean | null;
  verification?: VerificationResult;
}

interface SetupData {
  profile: string;
  mode: "existing" | "guided_import";
  approvedBy: null;
  store: string;
  app: null;
  readKey: SetupKeyData | null;
  visitor: SetupKeyData | null;
  terms: null;
  files: string[];
  demo?: boolean;
}

/** `data` of `arcopolis_setup_start` while an approval is waiting for the human. */
export interface PendingSetupData {
  status: "pending";
  resumed: boolean;
  userCode: string;
  expiresAt: string;
  humanAction: Record<string, unknown>;
}

/** Default app name: the project directory name, sanitized (at most 60 characters). */
export function defaultAppName(root: string): string {
  const name = path
    .basename(root)
    .replace(/[^A-Za-z0-9 _-]+/g, "-")
    .replace(/^[-_ ]+|[-_ ]+$/g, "")
    .slice(0, 60)
    .trim();
  return name || "my-app";
}

/** Slug from an app name: lowercase letters, digits, and single dashes (at most 32 characters). */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug || "visitor";
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Validated setup flags. `explicit` holds the request-shaping flags actually given. */
interface SetupInput {
  wantRead: boolean;
  wantVisitor: boolean;
  world: string | null;
  slug: string | undefined;
  appName: string | undefined;
  tier: 1 | 2 | 3;
  label: string | undefined;
  noLabel: boolean;
  expectEmail: string | null;
  envFile: string | undefined;
  wait: number | undefined;
  fresh: boolean;
  resume: boolean;
  noBrowser: boolean;
  verify: boolean;
  force: boolean;
  explicit: ReadonlySet<string>;
}

const REQUEST_FLAGS = ["read", "no-read", "visitor", "slug", "world", "app-name", "tier", "label", "no-label", "expect-email", "profile"] as const;

function invalidFlag(message: string): CliError {
  return new CliError("INVALID_FLAG_VALUE", message, { humanDecision: false });
}

function readSetupInput(ctx: CommandContext): SetupInput {
  const flags = ctx.flags;
  if (flagBoolean(flags, "read") && flagBoolean(flags, "no-read")) throw usageError("Use either --read or --no-read.");
  const wantRead = !flagBoolean(flags, "no-read");
  const wantVisitor = flagBoolean(flags, "visitor");
  if (!wantRead && !wantVisitor) throw usageError("Nothing to set up: --no-read without --visitor.");
  if (flagBoolean(flags, "new") && flagBoolean(flags, "resume")) throw usageError("Use either --new or --resume.");
  if (flagString(flags, "label") !== undefined && flagBoolean(flags, "no-label")) throw usageError("Use either --label or --no-label.");
  const world = flagString(flags, "world") ?? null;
  if (world !== null) assertAgentId(world, "--world");
  const slug = flagString(flags, "slug");
  if (slug !== undefined && !VISITOR_SLUG_PATTERN.test(slug)) throw invalidFlag("--slug must be 2 to 32 lowercase letters, digits, or inner hyphens.");
  const appName = flagString(flags, "app-name")?.trim();
  if (appName !== undefined && !isPrintableName(appName, 60)) throw invalidFlag("--app-name must be 1 to 60 printable characters.");
  const label = flagString(flags, "label");
  if (label !== undefined && sanitizeHostLabel(label) === null) throw invalidFlag("--label needs at least one printable ASCII character.");
  const email = flagString(flags, "expect-email")?.trim();
  if (email !== undefined && !isPlausibleEmail(email)) throw invalidFlag("--expect-email must be an email address.");
  const tier = flagNumber(flags, "tier") ?? 1;
  const explicit = new Set<string>(REQUEST_FLAGS.filter((name) => flags[name] !== undefined && flags[name] !== false));
  return {
    wantRead,
    wantVisitor,
    world,
    slug,
    appName,
    tier: (tier === 2 || tier === 3 ? tier : 1) as 1 | 2 | 3,
    label,
    noLabel: flagBoolean(flags, "no-label"),
    expectEmail: email ? email.toLowerCase() : null,
    envFile: flagString(flags, "write-env-file"),
    wait: flagNumber(flags, "wait"),
    fresh: flagBoolean(flags, "new"),
    resume: flagBoolean(flags, "resume"),
    noBrowser: flagBoolean(flags, "no-browser"),
    verify: !flagBoolean(flags, "no-verify"),
    force: flagBoolean(flags, "force"),
    explicit,
  };
}

/**
 * Why this run cannot resume `pending`, or null when it can. Only flags the
 * run actually gave are compared, so a plain `arcopolis setup --json` always
 * resumes the code the human already has. They are compared with what the
 * starting run asked for (`pending.asked`), not with the request after
 * narrowing (a visitor dropped because no world was open, or no read key
 * because one already resolved), so repeating the same command resumes the
 * same code. A file without `asked` falls back to the request itself.
 */
function pendingConflict(input: SetupInput, pending: PendingGrant, profile: string, developerBase: string): string | null {
  const has = (name: string): boolean => input.explicit.has(name);
  const request = pending.request;
  const asked = pending.asked;
  const askedRead = asked ? asked.read : request.readKey !== null;
  const askedVisitor = asked ? asked.visitor : request.visitor !== null;
  if (pending.developerBase !== developerBase) return "another control plane";
  if (has("profile") && pending.profile !== profile) return "another profile";
  if (has("no-read") && askedRead) return "no read key";
  if (has("read") && !askedRead) return "a read key";
  if (has("visitor") && !askedVisitor) return "a visitor";
  if (has("app-name") && request.app !== input.appName) return "another app name";
  if (has("tier") && (asked ? asked.tier : request.readKey?.tier) !== input.tier) return "another tier";
  if (has("slug") && (asked ? asked.slug : request.visitor?.slug) !== input.slug) return "another visitor slug";
  if (has("world") && (asked ? asked.world : request.visitor?.worldId) !== input.world) return "another world";
  if (has("expect-email") && pending.expectedEmail !== input.expectEmail) return "another expected account";
  if (has("no-label") && request.hostLabel !== null) return "no host label";
  if (has("label") && request.hostLabel !== sanitizeHostLabel(input.label)) return "another host label";
  return null;
}

// ---------------------------------------------------------------------------
// Existing keys
// ---------------------------------------------------------------------------

function keyState(kind: ImportKind, resolved: ResolvedCredentials, now: Date): KeyState {
  const key = kind === "read" ? resolved.read : resolved.visitor;
  if (!key) return "missing";
  if (kind === "visitor" && !resolved.agentId) return "missing";
  if (key.source === "env" || key.source === "legacy_env") return "env";
  const record = kind === "read" ? key.readRecord : key.visitorRecord;
  return isFresh(record?.lastVerifiedAt ?? null, now) || key.source === "demo" ? "fresh" : "stale";
}

function existingKeyData(kind: ImportKind, key: ResolvedKey, resolved: ResolvedCredentials, state: KeyState): SetupKeyData {
  const record = kind === "read" ? key.readRecord : key.visitorRecord;
  return {
    keyPrefix: redactKey(key.value),
    action: "existing",
    source: key.source,
    ...(key.variable ? { variable: key.variable } : {}),
    ...(kind === "read" ? { tier: key.readRecord?.tier ?? null } : { agentId: resolved.agentId?.value ?? null }),
    lastVerifiedAt: record?.lastVerifiedAt ?? null,
    verified: state === "fresh" || state === "verified" ? true : state === "env" || state === "unverified" ? null : false,
  };
}

/** One `GET /v1` for a stored key not verified in 24 hours. Auth failures mean the key must be replaced. */
async function verifyStaleKey(ctx: CommandContext, kind: ImportKind, resolved: ResolvedCredentials): Promise<KeyState> {
  const key = kind === "read" ? resolved.read : resolved.visitor;
  if (!key) return "missing";
  try {
    const client = await ctx.createDataClient(kind, kind === "visitor" && resolved.agentId ? { agentId: resolved.agentId.value } : {});
    await client.client.get("/", undefined, { envelope: false, purpose: "read" });
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    if (error.category === "auth") {
      ctx.warnings.add("STORED_KEY_REJECTED", `The stored ${kind} key was rejected (${error.code}); it has to be replaced.`);
      return "missing";
    }
    ctx.warnings.add("KEY_NOT_VERIFIED", `The stored ${kind} key could not be verified (${error.code}); keeping it.`);
    return "unverified";
  }
  if (key.profile && !ctx.mode.demo) {
    await markKeyVerified(ctx, { kind, profile: key.profile, key: key.value, at: ctx.now().toISOString() });
  }
  return "verified";
}

interface SignupState {
  open: boolean;
  visitorWorldsOpen: number | null;
  termsVersion: string | null;
}

/** `GET /_developer/signup`. A disabled portal (exit 8) is rethrown; other failures only warn. */
async function probeSignup(ctx: CommandContext): Promise<SignupState | null> {
  try {
    const response = await ctx.createControlClient().get<Record<string, unknown>>("/signup", undefined, { purpose: "control" });
    const data = response.data && typeof response.data === "object" ? response.data : {};
    const worlds = data.visitorWorlds && typeof data.visitorWorlds === "object" ? (data.visitorWorlds as { open?: unknown }).open : null;
    return {
      open: data.open === true,
      visitorWorldsOpen: typeof worlds === "number" ? worlds : null,
      termsVersion: typeof data.termsVersion === "string" ? data.termsVersion : null,
    };
  } catch (error) {
    if (error instanceof CliError && error.category === "unavailable") throw error;
    const code = error instanceof CliError ? error.code : "INTERNAL";
    ctx.warnings.add("SIGNUP_PROBE_FAILED", `The developer portal probe failed (${code}); continuing with setup.`);
    return null;
  }
}

function successNext(read: boolean, visitor: boolean): NextStep[] {
  const next: NextStep[] = [];
  if (read) {
    next.push({ command: "arcopolis agents list --per-page 5 --json", why: "First read", humanDecision: false });
    next.push({ command: "arcopolis exec -- node app.mjs", why: "Run your own program with ARCOPOLIS_API_KEY injected (replace `node app.mjs` with its command)", humanDecision: false });
  }
  if (visitor) next.push({ command: "arcopolis visitor status --json", why: "Cached visitor state (no network)", humanDecision: false });
  return next;
}

// ---------------------------------------------------------------------------
// Guided fallback (plan §4.2 step 7)
// ---------------------------------------------------------------------------

/** The exit-10 `humanAction` block of the guided fallback (no approval grant available). */
export function guidedHumanAction(input: {
  needRead: boolean;
  needVisitor: boolean;
  appName: string;
  tier: number;
  world: string | null;
  slug: string;
  visitorTermsVersion: string;
}): Record<string, unknown> {
  const steps: string[] = [];
  if (input.needRead) {
    steps.push(
      `Open ${PORTAL_READ_URL}, sign in with Google, and create an app and a read key${input.tier > 1 ? ` (tier ${input.tier})` : ""}. The key is shown only once.`,
    );
  }
  if (input.needVisitor) {
    steps.push(
      `Open ${PORTAL_AGENT_URL}, sign in, and register a visitor${input.world ? ` in world ${input.world}` : ""}. Note its agent id and its drive key.`,
    );
  }
  const environment = [...(input.needRead ? ENV_FOR.read : []), ...(input.needVisitor ? ENV_FOR.visitor : [])];
  steps.push(
    `Put ${environment.map((entry) => `${entry.holds} in ${entry.name}`).join(", ")} in this agent platform's secret or environment settings. Never paste a key into chat.`,
  );
  steps.push("Or run `arcopolis auth import` in a terminal on this machine; it reads the key from a hidden prompt.");
  steps.push("If the platform reads secrets only when a session starts, restart the session. Then tell the agent it is done.");
  const terms: Array<{ name: string; version: string }> = [{ name: DEVELOPER_TERMS.name, version: DEVELOPER_TERMS.version }];
  if (input.needVisitor) terms.push({ name: VISITOR_CORPUS_TERMS.name, version: input.visitorTermsVersion });
  const portalUrl = input.needRead ? PORTAL_READ_URL : PORTAL_AGENT_URL;
  const readPart = input.needRead ? `create a read key at ${PORTAL_READ_URL} and add it as ARCOPOLIS_API_KEY` : "";
  const visitorPart = input.needVisitor
    ? `register a visitor at ${PORTAL_AGENT_URL} and add its drive key as ARCOPOLIS_VISITOR_API_KEY and its agent id as ARCOPOLIS_VISITOR_AGENT_ID`
    : "";
  const what = [readPart, visitorPart].filter(Boolean).join(", then ");
  return {
    mode: "guided",
    portalUrl,
    links: {
      ...(input.needRead ? { read: PORTAL_READ_URL } : {}),
      ...(input.needVisitor ? { agent: PORTAL_AGENT_URL } : {}),
    },
    requested: {
      app: input.appName,
      readKey: input.needRead ? { tier: input.tier } : null,
      visitor: input.needVisitor ? { world: input.world, slug: input.slug } : null,
    },
    environment,
    steps,
    termsTheHumanWillSee: terms,
    tellTheHuman:
      `Sign in with Google and ${what} in this agent platform's secret settings (never paste a key into chat), ` +
      "or run `arcopolis auth import` in a terminal. Then tell me.",
  };
}

async function ensureStoreSafe(ctx: CommandContext): Promise<void> {
  if (ctx.mode.demo) return;
  const findings = await ctx.store.credentialStore.inspectPermissions();
  const bad = findings.filter((finding) => !finding.ok);
  if (bad.length) {
    throw new CliError("INSECURE_CREDENTIAL_FILE", `${bad.length} credential store path(s) are accessible to other users.`, {
      hint: "Run arcopolis doctor --fix-permissions, then run setup again.",
      details: { paths: bad.map((finding) => displayPath(finding.path)) },
    });
  }
  try {
    await access(ctx.store.paths.dir, fsConstants.W_OK);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
    if (code !== "ENOENT") ctx.warnings.add("STORE_NOT_WRITABLE", `${displayPath(ctx.store.paths.dir)} is not writable.`);
  }
}

/** TTY guided import: hidden prompts, store every key, then verify each. */
async function guidedImport(
  ctx: CommandContext,
  input: { needRead: boolean; needVisitor: boolean; world: string | null; verify: boolean; visitorTermsVersion: string },
): Promise<{ stored: Array<{ stored: StoredImport; key: string; verification: VerificationResult }> }> {
  const out = (line: string): void => ctx.io.stderr.write(`${line}\n`);
  out("Arcopolis setup (guided)");
  out("  One-approval setup is not available right now. Create the key in the portal, then paste it here.");
  const terms = [`${DEVELOPER_TERMS.name} (${DEVELOPER_TERMS.version})`];
  if (input.needVisitor) terms.push(`${VISITOR_CORPUS_TERMS.name} (${input.visitorTermsVersion})`);
  out(`  The portal asks you to accept: ${terms.join(" and ")}.`);
  const answers: Array<{ kind: ImportKind; key: string; agentId: string | null }> = [];
  if (input.needRead) {
    out("");
    out(`  Open  ${PORTAL_READ_URL}   (sign in, create an app and a read key)`);
    const key = await ctx.promptHidden("Paste the read key (input is hidden):");
    assertKeyFormat(key, "The read key");
    answers.push({ kind: "read", key, agentId: null });
  }
  if (input.needVisitor) {
    out("");
    out(`  Open  ${PORTAL_AGENT_URL}   (register a visitor; note its agent id and drive key)`);
    const agentId = await ctx.promptHidden("Visitor agent id (input is hidden):");
    assertAgentId(agentId, "The visitor agent id");
    const key = await ctx.promptHidden("Paste the visitor drive key (input is hidden):");
    assertKeyFormat(key, "The visitor drive key");
    answers.push({ kind: "visitor", key, agentId });
  }
  const profile = await resolveImportProfile(ctx);
  const stored: Array<{ stored: StoredImport; key: string; verification: VerificationResult }> = [];
  for (const answer of answers) {
    const record = await storeImportedKey(ctx, {
      kind: answer.kind,
      key: answer.key,
      profile,
      agentId: answer.agentId,
      worldId: answer.kind === "visitor" ? input.world : null,
    });
    stored.push({ stored: record, key: answer.key, verification: { verified: false, skipped: "no_verify" } });
  }
  if (input.verify) {
    for (const entry of stored) entry.verification = await verifyImportedKey(ctx, entry.stored, entry.key);
  }
  return { stored };
}

/** Everything the guided fallback needs from the preflight. */
interface GuidedContext {
  input: SetupInput;
  resolved: ResolvedCredentials;
  states: Partial<Record<ImportKind, KeyState>>;
  needRead: boolean;
  needVisitor: boolean;
  appName: string;
  visitorTermsVersion: string;
}

/** Plan §4.2 step 7: without a TTY exit 10 with human steps; in a TTY, hidden-prompt import. */
async function guidedSetup(ctx: CommandContext, guided: GuidedContext): Promise<DocumentResult<SetupData>> {
  const { input, resolved, states, needRead, needVisitor } = guided;
  const ignored = GRANT_ONLY_FLAGS.filter((name) => ctx.flags[name] !== undefined && ctx.flags[name] !== false);
  if (ignored.length) {
    ctx.warnings.add("GRANT_FLAGS_IGNORED", `Ignored by the guided setup (approval grants are not available): ${ignored.map((name) => `--${name}`).join(", ")}.`);
  }
  if (!ctx.mode.interactive || ctx.mode.demo || ctx.mode.mcp) {
    const humanAction = guidedHumanAction({
      needRead,
      needVisitor,
      appName: guided.appName,
      tier: input.tier,
      world: input.world,
      slug: input.slug ?? slugify(guided.appName),
      visitorTermsVersion: guided.visitorTermsVersion,
    });
    throw new CliError(
      "HUMAN_SETUP_REQUIRED",
      "A person must create the key in the developer portal and give it to this agent through secret settings.",
      {
        hint: "Give the human humanAction.tellTheHuman exactly. Never ask for a key in chat, and never open the portal or accept terms yourself.",
        humanDecision: true,
        humanAction,
        next: [
          {
            command: "arcopolis status --json",
            why: "After the human says the key is set, check that it resolves (no network)",
            humanDecision: false,
          },
        ],
      },
    );
  }
  const envFile = input.envFile;
  const apiBase = ctx.store.apiBase();
  // A stored key goes only to the origin it was saved for (plan §3.5), and a
  // key imported now is saved for this base; check before anything is asked.
  const storedReadForEnv = envFile && !needRead && resolved.read?.source === "store" ? resolved.read : null;
  if (envFile) assertKeysMatchBase(ctx, [storedReadForEnv]);
  const { stored } = await guidedImport(ctx, { needRead, needVisitor, world: input.world, verify: input.verify, visitorTermsVersion: guided.visitorTermsVersion });
  const files: string[] = [];
  if (envFile) {
    const vars: Record<string, string> = { ARCOPOLIS_API_BASE: apiBase.url };
    const readEntry = stored.find((entry) => entry.stored.kind === "read");
    const visitorEntry = stored.find((entry) => entry.stored.kind === "visitor");
    const readKey = readEntry?.key ?? storedReadForEnv?.value;
    if (readKey) vars.ARCOPOLIS_API_KEY = readKey;
    if (visitorEntry) {
      vars.ARCOPOLIS_VISITOR_API_KEY = visitorEntry.key;
      if (visitorEntry.stored.agentId) vars.ARCOPOLIS_VISITOR_AGENT_ID = visitorEntry.stored.agentId;
    }
    const gitRoot = await findGitRoot(ctx.cwd);
    const result = await writeEnvFile({
      root: gitRoot ?? ctx.cwd,
      file: path.resolve(ctx.cwd, envFile),
      vars,
      confirmGitignore: async (relative: string): Promise<boolean> => {
        const yes = await ctx.confirm(`${relative} is not ignored by git. Add it to .gitignore and write the keys?`);
        if (!yes) throw new CliError("CONFIRMATION_DECLINED", `${relative} was not written; the keys are in the store.`, { humanDecision: true });
        return true;
      },
    });
    if (result.action !== "unchanged") {
      ctx.effects.write("env_file");
      for (const variable of result.variables) if (/_KEY$/.test(variable.name)) ctx.effects.secretWritten(`env_file:${variable.name}`);
    }
    files.push(path.relative(ctx.cwd, result.path) || result.path);
    if (result.gitignore && result.gitignore.action !== "unchanged") {
      ctx.effects.write("project_files");
      files.push(".gitignore");
    }
  }
  const keyData = (kind: ImportKind): SetupKeyData | null => {
    const entry = stored.find((candidate) => candidate.stored.kind === kind);
    if (entry) {
      return {
        keyPrefix: entry.stored.keyPrefix,
        action: "imported",
        source: "store",
        ...(kind === "visitor" ? { agentId: entry.stored.agentId } : { tier: null }),
        lastVerifiedAt: entry.verification.verifiedAt ?? null,
        verified: entry.verification.verified,
        verification: entry.verification,
      };
    }
    const key = kind === "read" ? resolved.read : resolved.visitor;
    const state = states[kind];
    return key && state && (kind === "read" ? input.wantRead : input.wantVisitor && !needVisitor) ? existingKeyData(kind, key, resolved, state) : null;
  };
  const data: SetupData = {
    profile: stored[0]?.stored.profile ?? resolved.profile.name,
    mode: "guided_import",
    approvedBy: null,
    store: displayPath(ctx.store.paths.credentialsFile),
    app: null,
    readKey: input.wantRead ? keyData("read") : null,
    visitor: input.wantVisitor ? keyData("visitor") : null,
    terms: null,
    files,
  };
  return { data, next: successNext(data.readKey !== null, data.visitor !== null) };
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

/** `arcopolis_setup_start`'s success result while the human has not approved yet. */
function pendingResult(ctx: CommandContext, pending: PendingGrant, resumed: boolean): DocumentResult<PendingSetupData> {
  return {
    data: { status: "pending", resumed, userCode: pending.userCode, expiresAt: pending.expiresAt, humanAction: humanActionFor(pending, ctx.now()) },
    meta: { note: "Give the human humanAction.tellTheHuman exactly. Do not open the link, approve it, or accept terms yourself." },
    next: [{ command: "arcopolis_setup_finish", why: "Call after the human says they approved; it waits up to 30 seconds", humanDecision: false }],
  };
}

/**
 * Runs setup for the CLI (`cli`) or an MCP tool: `mcp_start` starts or
 * resumes a grant and returns its `humanAction` without polling;
 * `mcp_finish` polls a pending grant for at most 30 seconds.
 */
export async function runSetup(ctx: CommandContext, mode: SetupMode = "cli"): Promise<DocumentResult> {
  const input = readSetupInput(ctx);
  if (flagString(ctx.flags, "store") === "project" && ctx.store.paths.kind !== "project") {
    throw usageError(
      "--store project needs ARCOPOLIS_CONFIG_DIR=.arcopolis in this version, so every later command finds the same store.",
      "Set ARCOPOLIS_CONFIG_DIR=.arcopolis for this project (the .arcopolis/ directory is gitignored), then run setup again.",
    );
  }
  const grantInput: GrantSetupInput = {
    wait: input.wait,
    noBrowser: input.noBrowser,
    verify: input.verify,
    envFile: input.envFile,
    expectEmail: input.expectEmail,
  };

  // Step 1: offline preflight.
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major < 22) ctx.warnings.add("NODE_VERSION_UNSUPPORTED", `Node ${process.versions.node} is older than the supported Node 22.`);
  const apiBase = ctx.store.apiBase();
  const developerBase = ctx.store.developerBase();
  if (apiBase.kind === "custom") {
    ctx.warnings.add("CUSTOM_BASE", `ARCOPOLIS_API_BASE is the non-canonical host ${apiBase.host}; stored keys are never sent there.`);
  }
  await ensureStoreSafe(ctx);
  const store = ctx.store.credentialStore;
  if (input.fresh && !ctx.mode.demo) {
    if (await removePendingGrantFile(store)) ctx.effects.write("credential_store");
  }
  const pendingRead = ctx.mode.demo ? { grant: null, invalid: false } : await readPendingGrantFile(store);
  if (pendingRead.invalid) {
    ctx.warnings.add("PENDING_GRANT_INVALID", "pending-grant.json is not a pending approval this version understands; a new approval replaces it.");
  }
  const profile = await resolveImportProfile(ctx);
  let pending = pendingRead.grant;

  if (mode === "mcp_finish" || input.resume) {
    if (!pending) throw grantNotStarted(mode);
    if (!isGrantPossiblyLive(pending, ctx.now())) {
      // Keys stored before a crash are finished, never reported as expired.
      if (pending.stored) return finishStored(ctx, pending, grantInput, { acked: false });
      await removePendingGrantFile(store);
      throw grantExpired(mode, pending.userCode);
    }
    return awaitGrant(ctx, pending, grantInput, { mode, resumed: true });
  }
  if (pending) {
    const conflict = isGrantPossiblyLive(pending, ctx.now()) ? pendingConflict(input, pending, profile, developerBase.url) : "expired";
    if (conflict === null) {
      // Keys stored before a crash: one poll collects (acks) and finishes them.
      if (mode === "mcp_start" && !pending.stored) return pendingResult(ctx, pending, true);
      return awaitGrant(ctx, pending, grantInput, { mode, resumed: true });
    }
    if (conflict === "expired") {
      if (pending.stored) return finishStored(ctx, pending, grantInput, { acked: false });
      await removePendingGrantFile(store);
      ctx.warnings.add("PENDING_GRANT_EXPIRED", `The pending approval code ${pending.userCode} expired; this run starts over.`);
    } else {
      // Never replace an approval unread: finish it, or refuse while its page is open.
      const settled = await settleBeforeReplace(ctx, pending, grantInput, { mode, conflict });
      if (settled) return settled;
      ctx.warnings.add("PENDING_GRANT_REPLACED", `The pending approval ${pending.userCode} asked for something else (${conflict}); a new code replaces it.`);
    }
    pending = null;
  }

  const project = await ctx.store.project();
  const credentials = ctx.mode.demo ? await ctx.store.credentials() : await store.readCredentials();
  const resolved = resolveCredentials({
    env: ctx.env,
    flags: { profile: flagString(ctx.flags, "profile") },
    credentials,
    config: await ctx.store.config(),
    project: project.config,
    warn: (code, message) => ctx.warnings.add(code, message),
  });
  const now = ctx.now();
  const states: Partial<Record<ImportKind, KeyState>> = {};
  for (const kind of [input.wantRead ? "read" : null, input.wantVisitor ? "visitor" : null].filter(Boolean) as ImportKind[]) {
    let state = input.force ? "missing" : keyState(kind, resolved, now);
    if (state === "stale") state = input.verify ? await verifyStaleKey(ctx, kind, resolved) : "unverified";
    states[kind] = state;
  }
  const needRead = states.read === "missing";
  let needVisitor = states.visitor === "missing";
  const existingData = (): SetupData => ({
    profile: resolved.profile.name,
    mode: "existing",
    approvedBy: null,
    store: displayPath(ctx.store.paths.credentialsFile),
    app: null,
    readKey: input.wantRead && resolved.read && states.read ? existingKeyData("read", resolved.read, resolved, states.read) : null,
    visitor: input.wantVisitor && resolved.visitor && states.visitor ? existingKeyData("visitor", resolved.visitor, resolved, states.visitor) : null,
    terms: null,
    files: [],
    ...(ctx.mode.demo ? { demo: true } : {}),
  });
  const alreadySet = (visitor: boolean): DocumentResult => {
    if (input.envFile) {
      ctx.warnings.add("ENV_FILE_NOT_WRITTEN", "Nothing new was stored, so no env file was written; use arcopolis env write PATH.");
    }
    const data = existingData();
    return mode === "mcp_start" ? { data: { status: "configured", ...data }, next: successNext(input.wantRead, visitor) } : { data, next: successNext(input.wantRead, visitor) };
  };
  if (!needRead && !needVisitor) return alreadySet(input.wantVisitor);

  // Step 2: control-plane liveness and open visitor worlds (no auth, 0 writes).
  const signup = await probeSignup(ctx);
  if (needVisitor && signup && signup.visitorWorldsOpen === 0) {
    if (!input.wantRead) {
      throw new CliError("NO_VISITOR_WORLD_OPEN", "No visitor world is open right now, so a visitor cannot be registered.", {
        hint: "Tell the human; do not retry in a loop. A read key does not need an open world.",
        surface: "control",
      });
    }
    needVisitor = false;
    ctx.warnings.add("VISITOR_DROPPED", "No visitor world is open right now; setting up the read key only.");
    if (!needRead) return alreadySet(false);
  }
  const visitorTermsVersion = signup?.termsVersion ?? VISITOR_CORPUS_TERMS.version;
  const appName = input.appName ?? defaultAppName(project.gitRoot ?? ctx.cwd);

  // Anything that would make the env file unusable is refused before the human is asked.
  if (input.envFile) {
    if (apiBase.kind === "custom") {
      throw new CliError("STORED_KEY_ORIGIN_MISMATCH", `A stored key is never written next to the custom base ${apiBase.origin}.`, {
        hint: "Unset ARCOPOLIS_API_BASE, or supply the key through the environment for a custom base.",
        humanDecision: true,
      });
    }
    if (!ctx.mode.demo) await precheckEnvFile(ctx, input.envFile);
  }

  // Step 3: the approval grant. An unreachable control plane (the probe
  // already failed) cannot run one either, so that goes straight to the
  // guided steps, which need only the human's own browser.
  let started: PendingGrant | null = null;
  if (signup) {
    const installId = ctx.mode.demo ? ((await ctx.store.config()).installId ?? "000000") : await store.ensureInstallId();
    const slug = input.slug ?? defaultVisitorSlug(slugify(appName));
    const request = buildGrantRequest({
      app: appName,
      installId,
      readTier: needRead ? input.tier : null,
      visitor: needVisitor ? { slug, worldId: input.world } : null,
      label: input.label,
      noLabel: input.noLabel,
    });
    started = await startPendingGrant(ctx, {
      request,
      profile,
      expectedEmail: input.expectEmail,
      envFile: input.envFile ? path.resolve(ctx.cwd, input.envFile) : null,
      terms: termsFor(request, visitorTermsVersion),
      asked: { read: input.wantRead, tier: input.tier, visitor: input.wantVisitor, slug, world: input.world },
    });
  }
  if (started) {
    if (mode === "mcp_start") return pendingResult(ctx, started, false);
    if (!ctx.mode.interactive && (input.wait ?? 0) === 0) throw approvalPending(ctx, started, { resumed: false, status: null, mode });
    return awaitGrant(ctx, started, grantInput, { mode, resumed: false });
  }

  // Step 7: guided fallback (grants unavailable).
  return guidedSetup(ctx, { input, resolved, states, needRead, needVisitor, appName, visitorTermsVersion });
}

function renderSetupHuman(view: DocumentView): string {
  const record = view.data as { mode?: string };
  if (record.mode === "grant") return renderGrantHuman(view.data as GrantSetupData, view.next);
  const data = view.data as SetupData;
  const lines = [data.mode === "existing" ? "Arcopolis is already set up." : "Arcopolis setup done."];
  const describe = (label: string, key: SetupKeyData | null): void => {
    if (!key) return;
    const verified = key.verified === true ? "verified" : key.verified === false ? "not verified" : "not checked";
    lines.push(`  ${label.padEnd(9)} ${key.keyPrefix} (${key.action}, ${key.variable ?? key.source}, ${verified})`);
  };
  describe("Read key", data.readKey);
  describe("Visitor", data.visitor);
  lines.push(`  Store     ${data.store}`);
  if (data.files.length) lines.push(`  Files     ${data.files.join(", ")}`);
  const first = view.next[0];
  if (first) lines.push(`Next: ${first.command}`);
  return `${lines.join("\n")}\n`;
}

/** Flags of `setup` (also the source of the MCP setup tools' arguments). */
export const SETUP_FLAGS: CommandSpec["flags"] = [
  { name: "read", type: "boolean", description: "Request a read key (on by default)." },
  { name: "no-read", type: "boolean", description: "Do not request a read key." },
  { name: "visitor", type: "boolean", description: "Also request a visitor (only when the human asked for one)." },
  { name: "slug", type: "string", placeholder: "S", maxLength: 32, description: "Visitor slug (defaults to the app name slugified)." },
  { name: "world", type: "string", placeholder: "ID", description: "Visitor world id." },
  { name: "app-name", type: "string", placeholder: "N", maxLength: 60, description: "App name (defaults to the project directory name)." },
  { name: "tier", type: "integer", min: 1, max: 3, placeholder: "1|2|3", description: "Read key tier (default 1)." },
  { name: "label", type: "string", placeholder: "L", maxLength: 64, description: "Host label shown to the approver (default: this machine's hostname)." },
  { name: "no-label", type: "boolean", description: "Send no host label." },
  { name: "expect-email", type: "string", placeholder: "E", description: "Refuse an approval from any other account (only its hash is sent)." },
  { name: "store", type: "string", enum: ["user", "project"], description: "Where to save credentials (default user)." },
  {
    name: "write-env-file",
    type: "string",
    placeholder: "PATH",
    description: "Also write the keys into this gitignored env file (not --env-file, which Node itself intercepts).",
  },
  {
    name: "wait",
    type: "integer",
    min: 0,
    max: 600,
    placeholder: "SECONDS",
    description: "How long to wait for approval. Default: a terminal waits until the code expires; without one, 0 on a new code and 90 on a re-run (at most 110).",
  },
  { name: "new", type: "boolean", description: "Discard the pending approval and start over with a new code." },
  { name: "resume", type: "boolean", description: "Resume only; exit 5 GRANT_NOT_STARTED if there is none." },
  { name: "no-browser", type: "boolean", description: "Do not open a browser (terminal only)." },
  { name: "no-verify", type: "boolean", description: "Skip GET /v1 verification of new or stale keys." },
  { name: "force", type: "boolean", description: "Run even when the requested keys already resolve." },
];

export const commands: CommandSpec[] = [
  defineCommand({
    name: "setup",
    summary: "Get credentials with one human approval (falls back to the guided portal flow)",
    description:
      "Starts (or resumes) one approval: the human opens a link on any device, signs in with Google, checks the code, and " +
      "approves; the keys arrive encrypted to this terminal, are stored at 0600, and are verified with one GET /v1 each. " +
      "Without a TTY the first run exits 10 APPROVAL_PENDING with humanAction (link and code); the re-run resumes the same " +
      "code and waits up to 90 seconds. Denied is exit 10 APPROVAL_DENIED; expired is exit 13 CLI_GRANT_EXPIRED (setup --new). " +
      "When approvals are unavailable it falls back to the guided portal flow (exit 10 HUMAN_SETUP_REQUIRED without a TTY). " +
      "When the requested keys already resolve it exits 0 with no request. The CLI never accepts terms.",
    phase: 2,
    credentials: "none",
    confirmation: "human_approval",
    network: "control (GET /_developer/signup, POST /_developer/cli/grants and /grants/poll); data (GET /v1 per new or stale key unless --no-verify)",
    effects: { writes: ["cli_grant", "credential_store", "env_file", "project_files"], spends: ["rateLimit"] },
    flags: SETUP_FLAGS,
    positionals: [],
    errors: [
      "APPROVAL_PENDING",
      "APPROVAL_DENIED",
      "HUMAN_SETUP_REQUIRED",
      "CLI_GRANT_EXPIRED",
      "CLI_GRANT_NOT_FOUND",
      "CLI_GRANT_NOT_PENDING",
      "CLI_GRANT_RATE_LIMITED",
      "SLOW_DOWN",
      "APPROVER_MISMATCH",
      "GRANT_PAYLOAD_INVALID",
      "GRANT_BASE_MISMATCH",
      "NO_VISITOR_WORLD_OPEN",
      "DEVELOPER_PORTAL_DISABLED",
      "GRANT_NOT_STARTED",
      "INSECURE_CREDENTIAL_FILE",
      "INVALID_KEY_FORMAT",
      "INVALID_API_KEY",
      "KEY_REVOKED",
      "INPUT_REQUIRED",
      "PROMPT_TIMEOUT",
      "ENV_FILE_TRACKED",
      "ENV_FILE_NOT_IGNORED",
      "STORED_KEY_ORIGIN_MISMATCH",
      "STORE_NOT_IGNORED",
      "STORE_PATH_SYMLINK",
      "GITIGNORE_SYMLINK",
      "INVALID_RESPONSE",
      "USAGE_ERROR",
    ],
    exitCodes: [0, 1, 2, 3, 4, 5, 6, 8, 10, 11, 12, 13],
    outputSchema: objectSchema(
      {
        profile: { type: "string" },
        mode: { enum: ["existing", "guided_import", "grant"] },
        approvedBy: { type: ["string", "null"] },
        store: { type: "string" },
        userCode: { type: "string", description: "The approval code (grant mode)." },
        app: { type: ["object", "null"] },
        readKey: { type: ["object", "null"] },
        visitor: { type: ["object", "null"] },
        terms: { type: ["object", "null"] },
        files: { type: "array", items: { type: "string" } },
      },
      ["profile", "mode", "store", "readKey", "visitor", "files"],
    ),
    examples: ["arcopolis setup --json", "arcopolis setup --visitor --json", "arcopolis setup --new --json", "arcopolis setup --expect-email dev@example.com"],
    async run(ctx) {
      return runSetup(ctx, "cli");
    },
    renderHuman: renderSetupHuman,
  }),
];
