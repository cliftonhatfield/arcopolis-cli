/**
 * CLI provisioning grant client (plan §2.2, §2.3, §2.6 R1 and R2, §2.7, §5).
 *
 * The CLI calls exactly two control-plane routes, both without auth:
 * - R1 `POST /_developer/cli/grants` starts a grant with a fresh P-256 public
 *   key and an intent, and returns a user code for the human plus a device
 *   code that only this terminal holds.
 * - R2 `POST /_developer/cli/grants/poll` reads the status. While approved it
 *   returns the ciphertext envelope; `ack: true` consumes the grant (the ack
 *   is exempt from the server's 4 s poll spacing, so it follows the store at
 *   once).
 *
 * Everything the human sees is one code: the pending grant (device code,
 * private key, request) is kept in `pending-grant.json` (0600) so a re-run
 * resumes it. The payload is decrypted here, validated strictly, and stored
 * atomically at 0600 before the ack. This module holds the pure pieces and
 * the two requests; `setup` orchestrates them.
 */
import { createHash } from "node:crypto";
import { DEFAULT_API_BASE } from "./bases.js";
import {
  PENDING_GRANT_FILE,
  type CredentialStore,
  type CredentialsFile,
  type ProfileRecord,
  type ReadKeyRecord,
  type VisitorRecord,
} from "./credentials.js";
import {
  GrantEnvelopeError,
  decryptGrantEnvelope,
  parseGrantEnvelope,
  parsePrivateJwk,
  type GrantEnvelope,
  type P256PrivateJwk,
  type P256PublicJwk,
} from "./envelope.js";
import { CliError } from "./errors.js";
import type { HttpClient } from "./http.js";

/** `client.name` reported to R1 (shown to the approver as unverified). */
export const CLI_CLIENT_NAME = "arcopolis-cli";
/** RFC 8628 user-code alphabet the server mints from. */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_DISPLAY = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
export const DEVICE_CODE_PATTERN = /^agnts_dc_[0-9a-f]{64}$/;
/** An issued Public API key. */
export const GRANT_KEY_PATTERN = /^agnts_[0-9a-f]{64}$/;
/** Server-side document ids (app, key, agent) as `complete` validates them. */
const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Backend visitor slug (`VISITOR_SLUG`). */
export const VISITOR_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
/** World ids the start route accepts. */
export const GRANT_WORLD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TERMS_VERSION = /^\d{4}-\d{2}-\d{2}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const CLIENT_TOKEN = /^[0-9A-Za-z.+_-]{1,32}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

export const PENDING_GRANT_SCHEMA_VERSION = 1;
/** Default poll interval when the server gives none (it sends 5). */
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;
/**
 * Longest a grant can stay live: claim extends it to at most 20 minutes after
 * creation, and approval adds 10 more. Past this a pending grant is dead
 * without asking the server.
 */
export const GRANT_MAX_LIFETIME_MS = 30 * 60_000;
/** Non-interactive re-run default wait (plan §4.2). */
export const RESUME_WAIT_SECONDS = 90;
/** Hard cap on any non-interactive wait, so agent tool timeouts never hide the result. */
export const NON_INTERACTIVE_MAX_WAIT_SECONDS = 110;
/** `arcopolis_setup_finish` polls at most this long. */
export const MCP_FINISH_MAX_WAIT_SECONDS = 30;

const EXPECT_EMAIL_PREFIX = "arcopolis-cli-expect-email-v1:";
const READ_KEY_NAME_MAX = 60;
/**
 * Bound on an app or key name in a payload. The portal only trims these
 * names (no length limit), and the human may reuse an existing app or rotate
 * an existing key, so the CLI accepts any printable name up to this bound
 * rather than refusing keys that were already minted or rotated.
 */
const PORTAL_NAME_MAX = 500;

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

/** The 8-letter form of a user code (`WDJBMJHT`), or null when it is not one. */
export function normalizeUserCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 32 || !/^[A-Za-z\s-]+$/.test(value)) return null;
  const compact = value.replace(/[\s-]/g, "").toUpperCase();
  if (compact.length !== 8) return null;
  for (const char of compact) if (!USER_CODE_ALPHABET.includes(char)) return null;
  return compact;
}

/** Display form `XXXX-XXXX`. */
export function formatUserCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

/** `sha256Hex("arcopolis-cli-expect-email-v1:" + email.trim().toLowerCase())` (R1 `expectedEmailSha256`). */
export function expectedEmailHash(email: string): string {
  return createHash("sha256").update(`${EXPECT_EMAIL_PREFIX}${email.trim().toLowerCase()}`, "utf8").digest("hex");
}

/** Loose address check for `--expect-email` (the server only ever sees its hash). */
export function isPlausibleEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(value);
}

/**
 * Host label sent to the approver: printable ASCII only (anything else
 * becomes `-`), at most 64 characters; null when nothing is left.
 */
export function sanitizeHostLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[^\x20-\x7E]+/g, "-").trim().slice(0, 64).trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** 1 to `max` printable characters with no surrounding whitespace and no control characters. */
export function isPrintableName(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && [...value].length <= max && !CONTROL_CHARS.test(value);
}

/** The per-install read key name `<app> CLI <installId>` (at most 60 characters). */
export function readKeyName(app: string, installId: string): string {
  const suffix = ` CLI ${installId}`;
  const head = [...app].slice(0, READ_KEY_NAME_MAX - suffix.length).join("").trim();
  return `${head || "arcopolis"}${suffix}`;
}

/** `<platform>-<arch>` in the `[0-9A-Za-z.+_-]` alphabet R1 accepts. */
export function clientPlatform(platform: string = process.platform, arch: string = process.arch): string {
  const value = `${platform}-${arch}`.replace(/[^0-9A-Za-z.+_-]/g, "_").slice(0, 32);
  return CLIENT_TOKEN.test(value) ? value : "unknown";
}

/** `client.version` for R1 (the CLI version, or `unknown` if it does not fit the alphabet). */
export function clientVersion(version: string): string {
  return CLIENT_TOKEN.test(version) ? version : "unknown";
}

// ---------------------------------------------------------------------------
// The request and the pending grant (plan §5 `pending-grant.json`)
// ---------------------------------------------------------------------------

/** What this terminal asked for (the intent, plus the host label shown to the approver). */
export interface GrantRequest {
  app: string;
  readKey: { name: string; tier: 1 | 2 | 3 } | null;
  visitor: { slug: string; worldId: string | null } | null;
  hostLabel: string | null;
}

/**
 * What the run that started a grant asked for, before any narrowing (a
 * dropped visitor when no world was open, no read key when one already
 * resolved). A later run is compared with this, so repeating the same
 * command resumes the same code.
 */
export interface GrantAsk {
  read: boolean;
  tier: 1 | 2 | 3;
  visitor: boolean;
  /** The slug the run would use (given or defaulted). */
  slug: string;
  world: string | null;
}

function parseAsk(value: unknown): GrantAsk | null {
  if (!isRecord(value)) return null;
  if (typeof value.read !== "boolean" || typeof value.visitor !== "boolean" || typeof value.slug !== "string") return null;
  if (value.tier !== 1 && value.tier !== 2 && value.tier !== 3) return null;
  if (!(value.world === null || typeof value.world === "string")) return null;
  return { read: value.read, tier: value.tier, visitor: value.visitor, slug: value.slug, world: value.world };
}

/** Intent v1 for R1. */
export function intentOf(request: GrantRequest): Record<string, unknown> {
  return {
    kind: "setup",
    app: { name: request.app },
    readKey: request.readKey ? { name: request.readKey.name, tier: request.readKey.tier } : null,
    visitor: request.visitor ? { slug: request.visitor.slug, worldId: request.visitor.worldId } : null,
  };
}

/** One entry of `humanAction.termsTheHumanWillSee`. */
export interface GrantTerm {
  name: string;
  version: string;
}

/** Non-secret record of what was stored, written before the ack so a crash after it can finish. */
export interface StoredGrantSummary {
  at: string;
  account: { uid: string; email: string | null };
  app: { id: string; name: string; created: boolean };
  readKey: { id: string; action: "created" | "rotated" } | null;
  visitor: { agentId: string; keyId: string; action: "registered" | "rotated" } | null;
  terms: { developer: string; visitorCorpus: string | null };
  warnings: string[];
}

/** `pending-grant.json` (0600). Deleted on success, denial, or expiry. */
export interface PendingGrant {
  schemaVersion: 1;
  /** Display form `XXXX-XXXX`. */
  userCode: string;
  deviceCode: string;
  privateKeyJwk: P256PrivateJwk;
  publicKeyThumbprint: string;
  /** ISO-8601 UTC; the latest deadline the server reported. */
  expiresAt: string;
  interval: number;
  profile: string;
  /** Absolute path of the env file requested with `--write-env-file`, or null. */
  envFile: string | null;
  request: GrantRequest;
  /** Lowercased `--expect-email`, or null. */
  expectedEmail: string | null;
  createdAt: string;
  verificationUri: string;
  verificationUriComplete: string;
  /** The control-plane base the grant was started on; polls go only there. */
  developerBase: string;
  terms: GrantTerm[];
  /** What the starting run asked for; null in a file written before this field existed. */
  asked: GrantAsk | null;
  /** Set once the credentials were stored (before the ack). */
  stored: StoredGrantSummary | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
}

function parseRequest(value: unknown): GrantRequest | null {
  if (!isRecord(value) || typeof value.app !== "string") return null;
  let readKey: GrantRequest["readKey"] = null;
  if (value.readKey !== null) {
    const key = value.readKey;
    if (!isRecord(key) || typeof key.name !== "string" || (key.tier !== 1 && key.tier !== 2 && key.tier !== 3)) return null;
    readKey = { name: key.name, tier: key.tier };
  }
  let visitor: GrantRequest["visitor"] = null;
  if (value.visitor !== null) {
    const entry = value.visitor;
    if (!isRecord(entry) || typeof entry.slug !== "string" || !(entry.worldId === null || typeof entry.worldId === "string")) return null;
    visitor = { slug: entry.slug, worldId: entry.worldId };
  }
  if (!(value.hostLabel === null || typeof value.hostLabel === "string")) return null;
  return { app: value.app, readKey, visitor, hostLabel: value.hostLabel };
}

function parseStored(value: unknown): StoredGrantSummary | null {
  if (!isRecord(value) || !isIso(value.at) || !isRecord(value.account) || !isRecord(value.app) || !isRecord(value.terms)) return null;
  return value as unknown as StoredGrantSummary;
}

/** Validates `pending-grant.json`; null when it is not a v1 pending grant. */
export function parsePendingGrant(value: unknown): PendingGrant | null {
  if (!isRecord(value) || value.schemaVersion !== PENDING_GRANT_SCHEMA_VERSION) return null;
  const privateKeyJwk = parsePrivateJwk(value.privateKeyJwk);
  const request = parseRequest(value.request);
  if (
    typeof value.userCode !== "string" ||
    !USER_CODE_DISPLAY.test(value.userCode) ||
    typeof value.deviceCode !== "string" ||
    !DEVICE_CODE_PATTERN.test(value.deviceCode) ||
    !privateKeyJwk ||
    !request ||
    typeof value.publicKeyThumbprint !== "string" ||
    !isIso(value.expiresAt) ||
    !isIso(value.createdAt) ||
    typeof value.interval !== "number" ||
    typeof value.profile !== "string" ||
    !(value.envFile === null || typeof value.envFile === "string") ||
    !(value.expectedEmail === null || typeof value.expectedEmail === "string") ||
    typeof value.verificationUri !== "string" ||
    typeof value.verificationUriComplete !== "string" ||
    typeof value.developerBase !== "string" ||
    !Array.isArray(value.terms)
  ) {
    return null;
  }
  const stored = value.stored === null || value.stored === undefined ? null : parseStored(value.stored);
  if (value.stored && !stored) return null;
  return {
    schemaVersion: PENDING_GRANT_SCHEMA_VERSION,
    userCode: value.userCode,
    deviceCode: value.deviceCode,
    privateKeyJwk,
    publicKeyThumbprint: value.publicKeyThumbprint,
    expiresAt: value.expiresAt,
    interval: clampInterval(value.interval),
    profile: value.profile,
    envFile: value.envFile,
    request,
    expectedEmail: value.expectedEmail,
    createdAt: value.createdAt,
    verificationUri: value.verificationUri,
    verificationUriComplete: value.verificationUriComplete,
    developerBase: value.developerBase,
    terms: (value.terms as unknown[]).filter(
      (term): term is GrantTerm => isRecord(term) && typeof term.name === "string" && typeof term.version === "string",
    ),
    asked: parseAsk(value.asked),
    stored,
  };
}

/** Result of reading `pending-grant.json`. */
export interface PendingGrantRead {
  grant: PendingGrant | null;
  /** The file exists but is not a v1 pending grant (it is ignored, never deleted blindly). */
  invalid: boolean;
}

/** Reads `pending-grant.json` (secret file: refused when group- or world-readable). */
export async function readPendingGrantFile(store: CredentialStore): Promise<PendingGrantRead> {
  let raw: unknown;
  try {
    raw = await store.readJson<unknown>(PENDING_GRANT_FILE);
  } catch (error) {
    if (error instanceof CliError && error.code === "CREDENTIALS_FILE_INVALID") return { grant: null, invalid: true };
    throw error;
  }
  if (raw === null) return { grant: null, invalid: false };
  const grant = parsePendingGrant(raw);
  return { grant, invalid: grant === null };
}

/** Writes `pending-grant.json` atomically at 0600. */
export async function writePendingGrantFile(store: CredentialStore, grant: PendingGrant): Promise<void> {
  await store.writeJson(PENDING_GRANT_FILE, grant);
}

/** Deletes `pending-grant.json` (and with it the private key). */
export async function removePendingGrantFile(store: CredentialStore): Promise<boolean> {
  return store.remove(PENDING_GRANT_FILE);
}

/** Latest moment the grant could still be live (ms). */
export function grantLiveUntil(grant: Pick<PendingGrant, "expiresAt" | "createdAt">): number {
  return Math.max(Date.parse(grant.expiresAt), Date.parse(grant.createdAt) + GRANT_MAX_LIFETIME_MS);
}

/** False only when the grant is certainly dead (past every deadline it could have reached). */
export function isGrantPossiblyLive(grant: Pick<PendingGrant, "expiresAt" | "createdAt">, now: Date): boolean {
  return now.getTime() < grantLiveUntil(grant);
}

function clampInterval(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 60 ? Math.ceil(value) : DEFAULT_POLL_INTERVAL_SECONDS;
}

// ---------------------------------------------------------------------------
// R1: start
// ---------------------------------------------------------------------------

/** R1 body (exact fields; the server refuses any other). */
export interface StartGrantBody {
  client: { name: string; version: string; platform: string; hostLabel: string | null };
  publicKey: P256PublicJwk;
  intent: Record<string, unknown>;
  expectedEmailSha256: string | null;
}

/** R1 `201` data. */
export interface StartedGrant {
  userCode: string;
  deviceCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: string;
  expiresIn: number;
  interval: number;
}

function invalidControlResponse(what: string): CliError {
  return new CliError("INVALID_RESPONSE", `The CLI setup service returned ${what}.`, {
    surface: "control",
    humanDecision: false,
    hint: "Report it; run arcopolis setup --json again later.",
  });
}

/**
 * Checks the approval link: HTTPS (HTTP only on loopback), on the portal
 * origin when the control plane is canonical, and the complete form is
 * exactly `<verificationUri>#code=<userCode>`.
 */
function checkVerificationUris(data: Record<string, unknown>, userCode: string, portalOrigin: string | null): { uri: string; complete: string } {
  const uri = data.verificationUri;
  const complete = data.verificationUriComplete;
  if (typeof uri !== "string" || typeof complete !== "string") throw invalidControlResponse("no approval link");
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw invalidControlResponse("an invalid approval link");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) || parsed.search || parsed.hash || parsed.username) {
    throw invalidControlResponse("an approval link that is not a plain HTTPS URL");
  }
  if (portalOrigin && parsed.origin !== portalOrigin) throw invalidControlResponse("an approval link outside the developer portal");
  if (complete !== `${uri}#code=${userCode}`) throw invalidControlResponse("an approval link that does not carry the code");
  return { uri, complete };
}

/**
 * R1. Returns the grant, or throws the API error as a {@link CliError}
 * (see {@link isGrantsUnavailable} for the codes that mean "use the guided
 * setup"). `portalOrigin` pins the approval link when the control plane is
 * canonical.
 */
export async function startGrant(client: HttpClient, body: StartGrantBody, portalOrigin: string | null): Promise<StartedGrant> {
  const response = await client.post<Record<string, unknown>>("/cli/grants", body, { purpose: "control", write: false });
  const data = isRecord(response.data) ? response.data : null;
  if (!data) throw invalidControlResponse("no grant");
  const normalized = normalizeUserCode(data.userCode);
  if (normalized === null || data.userCode !== formatUserCode(normalized)) throw invalidControlResponse("an invalid user code");
  if (typeof data.deviceCode !== "string" || !DEVICE_CODE_PATTERN.test(data.deviceCode)) throw invalidControlResponse("an invalid device code");
  const links = checkVerificationUris(data, data.userCode as string, portalOrigin);
  if (!isIso(data.expiresAt)) throw invalidControlResponse("an invalid expiry");
  return {
    userCode: data.userCode as string,
    deviceCode: data.deviceCode,
    verificationUri: links.uri,
    verificationUriComplete: links.complete,
    expiresAt: data.expiresAt,
    expiresIn: typeof data.expiresIn === "number" && data.expiresIn > 0 ? Math.round(data.expiresIn) : 600,
    interval: clampInterval(data.interval),
  };
}

/**
 * True when R1's answer means grants are not available here, so `setup`
 * falls back to the guided flow: any 401 (a backend without the grant
 * routes answers through the portal's session guard), any 404 (no route),
 * and 503 `CLI_GRANTS_DISABLED` or `DEVELOPER_PORTAL_DISABLED`.
 */
export function isGrantsUnavailable(error: unknown): boolean {
  if (!(error instanceof CliError)) return false;
  if (error.httpStatus === 401 || error.httpStatus === 404) return true;
  return error.httpStatus === 503 && (error.code === "CLI_GRANTS_DISABLED" || error.code === "DEVELOPER_PORTAL_DISABLED");
}

// ---------------------------------------------------------------------------
// R2: poll
// ---------------------------------------------------------------------------

/** What `complete` recorded; the server validated it against Firestore. */
export interface GrantResultSummary {
  appId: string;
  readKey: { id: string; action: string } | null;
  visitor: { agentId: string; keyId: string; action: string } | null;
}

export type PollResult =
  | { status: "pending"; expiresAt: string | null; interval: number }
  | { status: "claimed"; claimedAt: string | null; expiresAt: string | null; interval: number }
  | { status: "approved"; approvedAt: string | null; expiresAt: string | null; envelope: unknown; resultSummary: GrantResultSummary | null }
  | { status: "consumed" }
  | { status: "denied" }
  | { status: "expired" };

function parseResultSummary(value: unknown): GrantResultSummary | null {
  if (!isRecord(value) || typeof value.appId !== "string") return null;
  const readKey = isRecord(value.readKey) && typeof value.readKey.id === "string" ? { id: value.readKey.id, action: String(value.readKey.action) } : null;
  const visitor =
    isRecord(value.visitor) && typeof value.visitor.agentId === "string" && typeof value.visitor.keyId === "string"
      ? { agentId: value.visitor.agentId, keyId: value.visitor.keyId, action: String(value.visitor.action) }
      : null;
  return { appId: value.appId, readKey, visitor };
}

/** R2. `ack: true` consumes an approved grant (a write); a plain poll is a read. */
export async function pollGrant(client: HttpClient, grant: Pick<PendingGrant, "userCode" | "deviceCode">, ack = false): Promise<PollResult> {
  const body: Record<string, unknown> = { userCode: grant.userCode, deviceCode: grant.deviceCode };
  if (ack) body.ack = true;
  const response = await client.post<Record<string, unknown>>("/cli/grants/poll", body, { purpose: "poll", write: false });
  const data = isRecord(response.data) ? response.data : null;
  const optionalIso = (value: unknown): string | null => (isIso(value) ? value : null);
  switch (data?.status) {
    case "pending":
      return { status: "pending", expiresAt: optionalIso(data.expiresAt), interval: clampInterval(data.interval) };
    case "claimed":
      return { status: "claimed", claimedAt: optionalIso(data.claimedAt), expiresAt: optionalIso(data.expiresAt), interval: clampInterval(data.interval) };
    case "approved":
      return {
        status: "approved",
        approvedAt: optionalIso(data.approvedAt),
        expiresAt: optionalIso(data.expiresAt),
        envelope: data.envelope,
        resultSummary: parseResultSummary(data.resultSummary),
      };
    case "consumed":
    case "denied":
    case "expired":
      return { status: data.status };
    default:
      throw invalidControlResponse("an unknown grant status");
  }
}

/** Options for {@link waitForGrant}. */
export interface WaitOptions {
  client: HttpClient;
  grant: Pick<PendingGrant, "userCode" | "deviceCode" | "interval">;
  /** How long to keep polling while the grant is pending or claimed (0: one poll). */
  waitMs: number;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Called after every poll (progress lines in a terminal). */
  onPoll?: (result: PollResult) => void;
}

/**
 * Polls until the grant leaves pending/claimed or the wait runs out, every
 * `interval` seconds (the server's, never faster). A `SLOW_DOWN` waits its
 * `Retry-After` and slows the interval by 5 seconds; with no time left it
 * is rethrown (exit 6). Returns the last result.
 */
export async function waitForGrant(options: WaitOptions): Promise<PollResult> {
  const deadline = options.now().getTime() + Math.max(0, options.waitMs);
  let interval = options.grant.interval;
  for (;;) {
    let result: PollResult;
    try {
      result = await pollGrant(options.client, options.grant);
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== "SLOW_DOWN") throw error;
      const retryMs = Math.max(1, error.retry.afterSeconds ?? interval) * 1000;
      interval = Math.min(60, Math.max(interval, Math.ceil(retryMs / 1000)) + 5);
      if (options.now().getTime() + retryMs > deadline) throw error;
      await options.sleep(retryMs);
      continue;
    }
    options.onPoll?.(result);
    if (result.status !== "pending" && result.status !== "claimed") return result;
    interval = Math.max(interval, result.interval);
    const sleepMs = interval * 1000;
    if (options.now().getTime() + sleepMs > deadline) return result;
    await options.sleep(sleepMs);
  }
}

// ---------------------------------------------------------------------------
// The payload (plan §2.7)
// ---------------------------------------------------------------------------

/** The decrypted provisioning payload, validated. */
export interface GrantPayload {
  v: 1;
  userCode: string;
  approvedAt: string;
  account: { uid: string; email: string | null };
  apiBase: string;
  app: { id: string; name: string; created: boolean };
  readKey: {
    id: string;
    key: string;
    name: string;
    tier: 1 | 2 | 3;
    scopes: string[];
    rateLimitPerMinute: number;
    action: "created" | "rotated";
  } | null;
  visitor: {
    agentId: string;
    handle: string;
    worldId: string;
    keyId: string;
    key: string;
    tier: number;
    scopes: string[];
    rateLimitPerMinute: number;
    /** Known at registration; null for a rotated key (the rotate route does not return it). */
    driveDailyBudget: number | null;
    keyCreatedAt: string | null;
    action: "registered" | "rotated";
  } | null;
  terms: {
    developer: { version: string; url: string };
    /** Null unless a visitor was registered in this approval. */
    visitorCorpus: { version: string; text: string } | null;
    acceptedAt: string;
  };
  warnings: string[];
}

/** A payload that failed validation; `field` names what (never its value). */
export class GrantPayloadError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "GrantPayloadError";
  }
}

function fail(field: string, rule: string): never {
  throw new GrantPayloadError(field, `payload.${field} ${rule}`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) fail(field, "must be an object");
  return value;
}

function docId(value: unknown, field: string): string {
  if (typeof value !== "string" || !DOC_ID.test(value)) fail(field, "must be a document id");
  return value;
}

function text(value: unknown, field: string, max = 200): string {
  if (!isPrintableName(value, max)) fail(field, `must be 1 to ${max} printable characters`);
  return value;
}

function isoField(value: unknown, field: string): string {
  if (!isIso(value)) fail(field, "must be an ISO-8601 UTC time");
  return value;
}

function apiKey(value: unknown, field: string): string {
  if (typeof value !== "string" || !GRANT_KEY_PATTERN.test(value)) fail(field, "must be a Public API key");
  return value;
}

function nonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000) fail(field, "must be a non-negative integer");
  return value;
}

function scopeList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32 || value.some((scope) => typeof scope !== "string" || !/^[a-z_]+:[a-z_]+$/.test(scope))) {
    fail(field, "must be a non-empty list of scopes");
  }
  return [...(value as string[])];
}

function termsVersion(value: unknown, field: string): string {
  if (typeof value !== "string" || !TERMS_VERSION.test(value)) fail(field, "must be a YYYY-MM-DD terms version");
  return value;
}

/**
 * Validates the decrypted payload strictly: every field §2.7 names, with its
 * type, and the cross-field rules the portal follows (`terms.visitorCorpus`
 * is set exactly when a visitor was registered; a rotated visitor's
 * `driveDailyBudget` may be null). The user code must be this grant's, keys
 * must be `agnts_` + 64 hex, and `apiBase` must be one of `allowedApiBases`.
 */
export function validateGrantPayload(value: unknown, options: { normalizedUserCode: string; allowedApiBases: readonly string[] }): GrantPayload {
  const payload = record(value, "(root)");
  if (payload.v !== 1) fail("v", "must be 1");
  if (payload.userCode !== options.normalizedUserCode) fail("userCode", "does not match this terminal's code");
  const approvedAt = isoField(payload.approvedAt, "approvedAt");
  const accountRecord = record(payload.account, "account");
  const account = {
    uid: text(accountRecord.uid, "account.uid", 128),
    email: accountRecord.email === null ? null : text(accountRecord.email, "account.email", 254),
  };
  if (typeof payload.apiBase !== "string" || !options.allowedApiBases.includes(payload.apiBase)) fail("apiBase", "is not the canonical API base");
  const appRecord = record(payload.app, "app");
  if (typeof appRecord.created !== "boolean") fail("app.created", "must be a boolean");
  const app = { id: docId(appRecord.id, "app.id"), name: text(appRecord.name, "app.name", PORTAL_NAME_MAX), created: appRecord.created };

  let readKey: GrantPayload["readKey"] = null;
  if (payload.readKey !== null) {
    const key = record(payload.readKey, "readKey");
    if (key.tier !== 1 && key.tier !== 2 && key.tier !== 3) fail("readKey.tier", "must be 1, 2, or 3");
    if (key.action !== "created" && key.action !== "rotated") fail("readKey.action", "must be created or rotated");
    readKey = {
      id: docId(key.id, "readKey.id"),
      key: apiKey(key.key, "readKey.key"),
      name: text(key.name, "readKey.name", PORTAL_NAME_MAX),
      tier: key.tier,
      scopes: scopeList(key.scopes, "readKey.scopes"),
      rateLimitPerMinute: nonNegativeInt(key.rateLimitPerMinute, "readKey.rateLimitPerMinute"),
      action: key.action,
    };
  }

  let visitor: GrantPayload["visitor"] = null;
  if (payload.visitor !== null) {
    const entry = record(payload.visitor, "visitor");
    if (entry.action !== "registered" && entry.action !== "rotated") fail("visitor.action", "must be registered or rotated");
    if (typeof entry.worldId !== "string" || !GRANT_WORLD_ID_PATTERN.test(entry.worldId)) fail("visitor.worldId", "must be a world id");
    if (typeof entry.tier !== "number" || !Number.isInteger(entry.tier) || entry.tier < 1 || entry.tier > 3) fail("visitor.tier", "must be 1, 2, or 3");
    if (!(entry.driveDailyBudget === null || (typeof entry.driveDailyBudget === "number" && Number.isInteger(entry.driveDailyBudget) && entry.driveDailyBudget >= 0))) {
      fail("visitor.driveDailyBudget", "must be a non-negative integer or null");
    }
    if (!(entry.keyCreatedAt === null || isIso(entry.keyCreatedAt))) fail("visitor.keyCreatedAt", "must be an ISO-8601 UTC time or null");
    visitor = {
      agentId: docId(entry.agentId, "visitor.agentId"),
      handle: text(entry.handle, "visitor.handle", 64),
      worldId: entry.worldId,
      keyId: docId(entry.keyId, "visitor.keyId"),
      key: apiKey(entry.key, "visitor.key"),
      tier: entry.tier,
      scopes: scopeList(entry.scopes, "visitor.scopes"),
      rateLimitPerMinute: nonNegativeInt(entry.rateLimitPerMinute, "visitor.rateLimitPerMinute"),
      driveDailyBudget: entry.driveDailyBudget as number | null,
      keyCreatedAt: entry.keyCreatedAt as string | null,
      action: entry.action,
    };
  }
  if (!readKey && !visitor) fail("readKey", "and payload.visitor are both null");
  if (readKey && visitor && readKey.key === visitor.key) fail("visitor.key", "repeats the read key");

  const termsRecord = record(payload.terms, "terms");
  const developer = record(termsRecord.developer, "terms.developer");
  if (typeof developer.url !== "string" || !/^https:\/\/\S+$/.test(developer.url) || developer.url.length > 300) fail("terms.developer.url", "must be an HTTPS URL");
  let visitorCorpus: GrantPayload["terms"]["visitorCorpus"] = null;
  if (termsRecord.visitorCorpus !== null) {
    const corpus = record(termsRecord.visitorCorpus, "terms.visitorCorpus");
    visitorCorpus = { version: termsVersion(corpus.version, "terms.visitorCorpus.version"), text: text(corpus.text, "terms.visitorCorpus.text", 1000) };
  }
  const registered = visitor?.action === "registered";
  if (registered && !visitorCorpus) fail("terms.visitorCorpus", "is required when a visitor was registered");
  if (!registered && visitorCorpus) fail("terms.visitorCorpus", "must be null unless a visitor was registered");
  const terms = {
    developer: { version: termsVersion(developer.version, "terms.developer.version"), url: developer.url },
    visitorCorpus,
    acceptedAt: isoField(termsRecord.acceptedAt, "terms.acceptedAt"),
  };

  if (!Array.isArray(payload.warnings) || payload.warnings.length > 20 || payload.warnings.some((warning) => !isPrintableName(warning, 500))) {
    fail("warnings", "must be a list of short strings");
  }
  return { v: 1, userCode: options.normalizedUserCode, approvedAt, account, apiBase: payload.apiBase, app, readKey, visitor, terms, warnings: [...(payload.warnings as string[])] };
}

/** Cross-checks the payload against the result summary the server validated. */
function checkAgainstSummary(payload: GrantPayload, summary: GrantResultSummary | null): void {
  if (!summary) return;
  if (summary.appId !== payload.app.id) fail("app.id", "differs from the server's record");
  if ((summary.readKey?.id ?? null) !== (payload.readKey?.id ?? null)) fail("readKey.id", "differs from the server's record");
  if ((summary.visitor?.agentId ?? null) !== (payload.visitor?.agentId ?? null)) fail("visitor.agentId", "differs from the server's record");
  if ((summary.visitor?.keyId ?? null) !== (payload.visitor?.keyId ?? null)) fail("visitor.keyId", "differs from the server's record");
}

/**
 * API bases a payload may name: the canonical base, plus this CLI's own base
 * when it is a loopback emulator (plan §3.5 treats loopback as canonical for
 * emulators). A custom host is never accepted.
 */
export function allowedPayloadApiBases(current: { url: string; kind: string }): string[] {
  return current.kind === "loopback" && current.url !== DEFAULT_API_BASE ? [DEFAULT_API_BASE, current.url] : [DEFAULT_API_BASE];
}

/** `GRANT_PAYLOAD_INVALID` (exit 1): nothing is stored and the grant is not acknowledged. */
export function payloadInvalid(reason: string, field: string | null, userCode: string): CliError {
  return new CliError("GRANT_PAYLOAD_INVALID", `The approved setup payload could not be used: ${reason} Nothing was stored.`, {
    surface: "local",
    humanDecision: true,
    hint:
      "Tell the human; do not loop. The encrypted copy stays on the server until the approval expires, and the keys the approval made are in the developer portal.",
    details: { field, userCode },
  });
}

/**
 * Decrypts and validates an approved envelope for this pending grant. Every
 * failure is `GRANT_PAYLOAD_INVALID` naming the failing field only.
 */
export async function openGrantEnvelope(
  envelope: unknown,
  grant: Pick<PendingGrant, "userCode" | "privateKeyJwk">,
  options: { allowedApiBases: readonly string[]; resultSummary: GrantResultSummary | null },
): Promise<GrantPayload> {
  const normalizedUserCode = normalizeUserCode(grant.userCode) ?? "";
  let text: string;
  try {
    const parsed: GrantEnvelope = parseGrantEnvelope(envelope);
    text = await decryptGrantEnvelope(parsed, { privateKey: grant.privateKeyJwk, normalizedUserCode });
  } catch (error) {
    if (error instanceof GrantEnvelopeError) throw payloadInvalid(error.message, "envelope", grant.userCode);
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw payloadInvalid("it is not JSON.", "(root)", grant.userCode);
  }
  try {
    const payload = validateGrantPayload(raw, { normalizedUserCode, allowedApiBases: options.allowedApiBases });
    checkAgainstSummary(payload, options.resultSummary);
    return payload;
  } catch (error) {
    if (error instanceof GrantPayloadError) throw payloadInvalid(`${error.message}.`, error.field, grant.userCode);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Storage (plan §5 credentials.json)
// ---------------------------------------------------------------------------

/**
 * Writes the delivered keys into `profile` of `credentials.json` (atomic,
 * 0600, under its lock). Resources the approval did not deliver are kept.
 * Each key is bound to the origin of `payload.apiBase`.
 */
export async function storeGrantCredentials(
  store: CredentialStore,
  input: { profile: string; payload: GrantPayload; developerBase: string; savedAt: string },
): Promise<void> {
  const { payload } = input;
  const origin = new URL(payload.apiBase).origin;
  await store.updateCredentials((file: CredentialsFile) => {
    const previous: ProfileRecord | undefined = file.profiles[input.profile];
    const profile: ProfileRecord = previous ?? { source: "grant" };
    profile.source = "grant";
    profile.apiBase = payload.apiBase;
    profile.developerBase = input.developerBase;
    profile.account = { uid: payload.account.uid, email: payload.account.email };
    profile.app = { id: payload.app.id, name: payload.app.name };
    if (payload.readKey) {
      const readKey: ReadKeyRecord = {
        id: payload.readKey.id,
        key: payload.readKey.key,
        name: payload.readKey.name,
        tier: payload.readKey.tier,
        scopes: payload.readKey.scopes,
        rateLimitPerMinute: payload.readKey.rateLimitPerMinute,
        origin,
        savedAt: input.savedAt,
        lastVerifiedAt: null,
      };
      profile.readKey = readKey;
    }
    if (payload.visitor) {
      const prior = previous?.visitor;
      const keepBudget = payload.visitor.driveDailyBudget === null && prior?.agentId === payload.visitor.agentId ? (prior.driveDailyBudget ?? null) : null;
      const visitor: VisitorRecord = {
        agentId: payload.visitor.agentId,
        handle: payload.visitor.handle,
        worldId: payload.visitor.worldId,
        keyId: payload.visitor.keyId,
        key: payload.visitor.key,
        driveDailyBudget: payload.visitor.driveDailyBudget ?? keepBudget,
        keyCreatedAt: payload.visitor.keyCreatedAt,
        origin,
        savedAt: input.savedAt,
        lastVerifiedAt: null,
      };
      profile.visitor = visitor;
    }
    profile.terms = {
      developer: payload.terms.developer.version,
      visitorCorpus: payload.terms.visitorCorpus?.version ?? previous?.terms?.visitorCorpus ?? null,
      acceptedVia: "portal_approval",
    };
    file.profiles[input.profile] = profile;
  });
}

/** The non-secret summary recorded in `pending-grant.json` once the keys are stored. */
export function storedSummaryOf(payload: GrantPayload, at: string): StoredGrantSummary {
  return {
    at,
    account: { ...payload.account },
    app: { ...payload.app },
    readKey: payload.readKey ? { id: payload.readKey.id, action: payload.readKey.action } : null,
    visitor: payload.visitor ? { agentId: payload.visitor.agentId, keyId: payload.visitor.keyId, action: payload.visitor.action } : null,
    terms: { developer: payload.terms.developer.version, visitorCorpus: payload.terms.visitorCorpus?.version ?? null },
    warnings: [...payload.warnings],
  };
}
