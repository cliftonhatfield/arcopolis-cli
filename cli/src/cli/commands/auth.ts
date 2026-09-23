/**
 * `arcopolis auth status|import|forget` (plan §4.3).
 *
 * - `status`: the resolved credentials and which source won, redacted.
 * - `import`: stores an existing key at 0600 from `--stdin`, `--from-env NAME`,
 *   or a hidden TTY prompt (never from an argument), then verifies it with one
 *   `GET /v1` unless `--no-verify`.
 * - `forget`: deletes the local copy after a TTY y/N or `--yes`. The keys
 *   stay valid on the server; the portal link says where to revoke them.
 *
 * The import primitives are exported for `setup`'s guided fallback.
 */
import { PORTAL_ORIGIN } from "../../core/bases.js";
import {
  AGENT_ID_PATTERN,
  displayPath,
  isValidApiKey,
  resolveProfileName,
  type CredentialsFile,
  type ProfileRecord,
  type ReadKeyRecord,
  type VisitorRecord,
} from "../../core/credentials.js";
import { CliError, type ErrorCategory } from "../../core/errors.js";
import { errno } from "../../core/files.js";
import { redactKey } from "../../core/redact.js";
import {
  defineCommand,
  flagBoolean,
  flagString,
  objectSchema,
  usageError,
  type CommandContext,
  type CommandSpec,
  type DocumentView,
  type NextStep,
} from "../spec.js";
import { setCredentialEnvNames, storeLabel, summarizeReadKey, summarizeVisitor, type KeySummary, type VisitorSummary } from "./status.js";

/** How long `--stdin` waits for the key before giving up. */
export const STDIN_KEY_TIMEOUT_MS = 30_000;
/** Largest stdin payload accepted for a key. */
export const MAX_STDIN_BYTES = 4096;

export type ImportKind = "read" | "visitor";
export type KeyInputSource = "stdin" | "env" | "prompt";

/** Outcome of verifying an imported key with `GET /v1`. */
export interface VerificationResult {
  verified: boolean;
  verifiedAt?: string;
  /** Why no request was sent (`no_verify`, `custom_base`, `env_override`, `resolution_cached`, `demo`). */
  skipped?: string;
  /** Environment variable that overrode the stored key, when skipped for that reason. */
  variable?: string | null;
  /** A non-auth failure (edge, transient, rate limit): the key stays stored. */
  error?: { code: string; category: ErrorCategory; exitCode: number };
}

/** What an import stored (never the key itself). */
export interface StoredImport {
  profile: string;
  kind: ImportKind;
  keyPrefix: string;
  agentId: string | null;
  worldId: string | null;
  createdProfile: boolean;
  previous: ReadKeyRecord | VisitorRecord | null;
}

/** Output of one import (redacted). */
export interface ImportSummary {
  profile: string;
  kind: ImportKind;
  keyPrefix: string;
  source: KeyInputSource;
  store: string;
  fileMode: "0600";
  stored: boolean;
  agentId?: string | null;
  worldId?: string | null;
  verified: boolean;
  verification: VerificationResult;
}

/** Resolves the profile a key is imported into (same order as every other command). */
export async function resolveImportProfile(ctx: CommandContext): Promise<string> {
  const project = await ctx.store.project();
  const config = await ctx.store.config();
  return resolveProfileName({ env: ctx.env, flags: { profile: flagString(ctx.flags, "profile") }, config, project: project.config }).name;
}

/** Throws `INVALID_KEY_FORMAT` (exit 2) without echoing the value. */
export function assertKeyFormat(key: string, label = "The key"): void {
  if (!isValidApiKey(key)) {
    throw new CliError("INVALID_KEY_FORMAT", `${label} is not a Public API key (expected agnts_ followed by 64 lowercase hex characters).`, {
      hint: "Copy the whole key from the portal. It is shown only once; rotate it in the portal if it was lost.",
      humanDecision: false,
    });
  }
}

/** Throws `INVALID_FLAG_VALUE` (exit 2) for a malformed agent or world id. */
export function assertAgentId(value: string, flag: string): void {
  if (!AGENT_ID_PATTERN.test(value)) {
    throw new CliError("INVALID_FLAG_VALUE", `${flag} must match ^[A-Za-z0-9_:.-]{1,240}$.`, { humanDecision: false });
  }
}

/**
 * Reads the whole of stdin (bounded in size and time). Used by `--stdin`, so a
 * key can be piped from a secret manager without touching argv.
 */
export function readStdinKey(ctx: CommandContext, timeoutMs = STDIN_KEY_TIMEOUT_MS): Promise<string> {
  const stdin = ctx.io.stdin;
  return new Promise<string>((resolve, reject) => {
    let text = "";
    let settled = false;
    const finish = (error: CliError | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onError);
      stdin.pause();
      if (error) reject(error);
      else resolve(text.trim());
    };
    const onData = (chunk: Buffer | string): void => {
      text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (Buffer.byteLength(text) > MAX_STDIN_BYTES) {
        finish(new CliError("INVALID_KEY_FORMAT", "stdin carried more than one key; send only the key.", { humanDecision: false }));
      }
    };
    const onEnd = (): void => finish(null);
    const onError = (): void => finish(new CliError("INPUT_REQUIRED", "stdin could not be read.", { humanDecision: true }));
    const timer = setTimeout(
      () =>
        finish(
          new CliError("INPUT_REQUIRED", `No key arrived on stdin within ${Math.round(timeoutMs / 1000)} seconds.`, {
            hint: "Pipe the key and close stdin, for example: <secret-manager command> | arcopolis auth import --stdin",
            humanDecision: true,
          }),
        ),
      timeoutMs,
    );
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    stdin.resume();
  });
}

/**
 * Reads the key from `--stdin`, `--from-env NAME`, or a hidden prompt.
 * Non-interactive sessions without a source get `INPUT_REQUIRED` (exit 10).
 */
export async function readKeyInput(ctx: CommandContext, question: string): Promise<{ key: string; source: KeyInputSource }> {
  const fromStdin = flagBoolean(ctx.flags, "stdin");
  const fromEnv = flagString(ctx.flags, "from-env");
  if (fromStdin && fromEnv !== undefined) throw usageError("Use either --stdin or --from-env, not both.");
  if (fromStdin) return { key: await readStdinKey(ctx), source: "stdin" };
  if (fromEnv !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fromEnv)) {
      throw new CliError("INVALID_FLAG_VALUE", "--from-env takes an environment variable name, not a value.", { humanDecision: false });
    }
    const value = ctx.env[fromEnv]?.trim();
    if (!value) {
      throw new CliError("INVALID_FLAG_VALUE", `--from-env ${fromEnv}: that variable is not set in this environment.`, {
        hint: "Ask the human to set it in the agent platform's secret settings, then restart the session.",
        humanDecision: false,
      });
    }
    return { key: value, source: "env" };
  }
  if (!ctx.mode.interactive) {
    throw new CliError("INPUT_REQUIRED", "No key source was given and this session cannot prompt.", {
      hint: "Use --stdin (pipe the key) or --from-env NAME. Never put a key in an argument or in chat.",
      humanDecision: true,
    });
  }
  return { key: await ctx.promptHidden(question), source: "prompt" };
}

function storeWriteError(error: unknown): unknown {
  const code = errno(error);
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new CliError("STORE_NOT_WRITABLE", "The credential store directory is not writable.", {
      category: "forbidden",
      hint: "Fix the directory permissions, or set ARCOPOLIS_CONFIG_DIR to a writable directory.",
      humanDecision: true,
    });
  }
  return error;
}

/**
 * Stores one key in the resolved profile (atomic, 0600, locked) and records
 * the effects. Returns what was replaced so a failed verification can roll
 * back. Never called in demo mode.
 */
export async function storeImportedKey(
  ctx: CommandContext,
  input: { kind: ImportKind; key: string; profile: string; agentId?: string | null; worldId?: string | null },
): Promise<StoredImport> {
  const base = ctx.store.apiBase();
  const savedAt = ctx.now().toISOString();
  let previous: ReadKeyRecord | VisitorRecord | null = null;
  let createdProfile = false;
  try {
    await ctx.store.credentialStore.updateCredentials((file: CredentialsFile) => {
      let profile: ProfileRecord | undefined = file.profiles[input.profile];
      if (!profile) {
        createdProfile = true;
        profile = { source: "import", terms: { developer: null, visitorCorpus: null, acceptedVia: "import" } };
        file.profiles[input.profile] = profile;
      }
      profile.apiBase = base.url;
      if (input.kind === "read") {
        previous = profile.readKey ?? null;
        profile.readKey = { key: input.key, origin: base.origin, savedAt, lastVerifiedAt: null };
      } else {
        previous = profile.visitor ?? null;
        profile.visitor = {
          agentId: input.agentId ?? "",
          worldId: input.worldId ?? null,
          key: input.key,
          origin: base.origin,
          savedAt,
          lastVerifiedAt: null,
        };
      }
    });
  } catch (error) {
    throw storeWriteError(error);
  }
  ctx.effects.write("credential_store");
  ctx.effects.secretWritten(input.kind === "read" ? "credential_store:readKey" : "credential_store:visitorKey");
  return {
    profile: input.profile,
    kind: input.kind,
    keyPrefix: redactKey(input.key),
    agentId: input.agentId ?? null,
    worldId: input.worldId ?? null,
    createdProfile,
    previous,
  };
}

/** Restores the record an import replaced (only if the imported key is still the one stored). */
async function rollbackImport(ctx: CommandContext, stored: StoredImport, key: string): Promise<void> {
  await ctx.store.credentialStore.updateCredentials((file: CredentialsFile) => {
    const profile = file.profiles[stored.profile];
    if (!profile) return;
    if (stored.kind === "read") {
      if (profile.readKey?.key !== key) return;
      if (stored.previous) profile.readKey = stored.previous as ReadKeyRecord;
      else delete profile.readKey;
    } else {
      if (profile.visitor?.key !== key) return;
      if (stored.previous) profile.visitor = stored.previous as VisitorRecord;
      else delete profile.visitor;
    }
    if (stored.createdProfile && !profile.readKey && !profile.visitor) delete file.profiles[stored.profile];
  });
}

/** Stamps `lastVerifiedAt` on a stored key (only if that key is still stored). */
export async function markKeyVerified(
  ctx: CommandContext,
  input: { kind: ImportKind; profile: string; key: string; at: string },
): Promise<void> {
  await ctx.store.credentialStore.updateCredentials((file: CredentialsFile) => {
    const profile = file.profiles[input.profile];
    if (input.kind === "read" && profile?.readKey?.key === input.key) profile.readKey.lastVerifiedAt = input.at;
    if (input.kind === "visitor" && profile?.visitor?.key === input.key) profile.visitor.lastVerifiedAt = input.at;
  });
  ctx.effects.write("credential_store");
}

/**
 * Verifies a just-stored key with one `GET /v1` through the context's data
 * client (so the store key is sent only to its own origin). The key must be
 * the one the context resolves: an environment variable of the same kind
 * with a different value skips verification. An auth failure (exit 3) rolls
 * the store back and is rethrown; any other failure leaves the key stored
 * and is reported as unverified.
 */
export async function verifyImportedKey(ctx: CommandContext, stored: StoredImport, key: string): Promise<VerificationResult> {
  if (ctx.store.apiBase().kind === "custom") return { verified: false, skipped: "custom_base" };
  let client: Awaited<ReturnType<CommandContext["createDataClient"]>>;
  // Re-resolve so a resolution cached earlier in this run (for example setup's preflight) sees the new key.
  ctx.store.invalidate();
  try {
    client = await ctx.createDataClient(stored.kind, stored.kind === "visitor" && stored.agentId ? { agentId: stored.agentId } : {});
  } catch (error) {
    // The context resolves credentials once per run; a resolution cached before this write cannot see the new key.
    if (!(error instanceof CliError) || error.code !== "NO_CREDENTIALS") throw error;
    ctx.warnings.add("KEY_NOT_VERIFIED", "The key was saved but not verified in this run. Run arcopolis doctor --online --verify.");
    return { verified: false, skipped: "resolution_cached" };
  }
  if (client.key.value !== key) {
    const envOverride = client.key.source === "env" || client.key.source === "legacy_env";
    ctx.warnings.add(
      "KEY_NOT_VERIFIED",
      envOverride
        ? `The key was saved but not verified: ${client.key.variable ?? "an environment variable"} overrides it in this session.`
        : "The key was saved but not verified in this run. Run arcopolis doctor --online --verify.",
    );
    return envOverride
      ? { verified: false, skipped: "env_override", variable: client.key.variable ?? null }
      : { verified: false, skipped: "resolution_cached" };
  }
  try {
    await client.client.get("/", undefined, { envelope: false, purpose: "read" });
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    if (error.category === "auth") {
      await rollbackImport(ctx, stored, key);
      throw new CliError(error.code, `${error.message} The key was not saved.`, {
        httpStatus: error.httpStatus,
        surface: error.surface,
        details: error.details,
        hint: "Check the key was copied whole and was not deleted or rotated in the portal (https://developers.arcologylabs.com).",
      });
    }
    ctx.warnings.add("KEY_NOT_VERIFIED", `The key was saved but could not be verified (${error.code}). Run arcopolis doctor --online --verify later.`);
    return { verified: false, error: { code: error.code, category: error.category, exitCode: error.exitCode } };
  }
  const at = ctx.now().toISOString();
  await markKeyVerified(ctx, { kind: stored.kind, profile: stored.profile, key, at });
  return { verified: true, verifiedAt: at };
}

/** Store then verify one key (the whole of `auth import` after input is read). */
export async function importKey(
  ctx: CommandContext,
  input: { kind: ImportKind; key: string; source: KeyInputSource; agentId?: string | null; worldId?: string | null; verify: boolean },
): Promise<ImportSummary> {
  assertKeyFormat(input.key);
  const profile = await resolveImportProfile(ctx);
  const base: Omit<ImportSummary, "stored" | "verified" | "verification"> = {
    profile,
    kind: input.kind,
    keyPrefix: redactKey(input.key),
    source: input.source,
    store: displayPath(ctx.store.paths.credentialsFile),
    fileMode: "0600",
    ...(input.kind === "visitor" ? { agentId: input.agentId ?? null, worldId: input.worldId ?? null } : {}),
  };
  if (ctx.mode.demo) {
    return { ...base, stored: false, verified: false, verification: { verified: false, skipped: "demo" } };
  }
  const stored = await storeImportedKey(ctx, { ...input, profile });
  const verification = input.verify ? await verifyImportedKey(ctx, stored, input.key) : { verified: false, skipped: "no_verify" };
  return { ...base, stored: true, verified: verification.verified, verification };
}

/** Warns (by name only) about environment variables that still supply keys after an import or forget. */
function envOverrideWarnings(ctx: CommandContext, kind: ImportKind | "all"): void {
  const names = setCredentialEnvNames(ctx.env).filter((name) =>
    kind === "all"
      ? /API_KEY|AGENT_ID/.test(name)
      : kind === "read"
        ? name === "ARCOPOLIS_API_KEY" || name === "AGNTS_API_KEY"
        : name === "ARCOPOLIS_VISITOR_API_KEY",
  );
  for (const name of names) {
    ctx.warnings.add(
      "ENV_OVERRIDES_STORE",
      kind === "all"
        ? `${name} is still set in the environment, so commands keep using it.`
        : `${name} is set in the environment and takes precedence over the stored key.`,
    );
  }
}

interface AuthStatusData {
  profile: { name: string; source: string; exists: boolean };
  store: string;
  profiles: string[];
  read: KeySummary;
  visitor: VisitorSummary;
  environment: string[];
}

function renderAuthStatusHuman(view: DocumentView): string {
  const data = view.data as AuthStatusData;
  const key = (label: string, summary: KeySummary): string =>
    summary.configured
      ? `  ${label.padEnd(9)} ${summary.keyPrefix} from ${summary.variable ? `${summary.source} (${summary.variable})` : summary.source}`
      : `  ${label.padEnd(9)} not configured`;
  const lines = [
    `Profile ${data.profile.name} (${data.profile.source}${data.profile.exists ? "" : ", not in the store"})`,
    `  Store     ${data.store}`,
    key("Read key", data.read),
    key("Visitor", data.visitor),
  ];
  if (data.environment.length) lines.push(`  Env set   ${data.environment.join(", ")}`);
  for (const step of view.next) lines.push(`Next: ${step.command}`);
  return `${lines.join("\n")}\n`;
}

function renderImportHuman(view: DocumentView): string {
  const data = view.data as ImportSummary;
  const lines = [
    data.stored
      ? `Saved ${data.kind === "read" ? "read key" : "visitor key"} ${data.keyPrefix} to ${data.store} (0600), profile ${data.profile}.`
      : `Demo mode: would save ${data.keyPrefix} to profile ${data.profile}; nothing was written.`,
    data.verified
      ? "Verified: GET /v1 ok."
      : `Not verified${data.verification.skipped ? ` (${data.verification.skipped})` : data.verification.error ? ` (${data.verification.error.code})` : ""}.`,
  ];
  for (const step of view.next) lines.push(`Next: ${step.command}`);
  return `${lines.join("\n")}\n`;
}

interface ForgetData {
  profile: string;
  removed: boolean;
  removedKeys: Array<{ kind: ImportKind; keyPrefix: string }>;
  keysStillValid: boolean;
  portal: string;
  message: string;
  demo?: boolean;
}

function renderForgetHuman(view: DocumentView): string {
  return `${(view.data as ForgetData).message}\n`;
}

export const commands: CommandSpec[] = [
  defineCommand({
    name: "auth status",
    summary: "Show the resolved credentials and which source won, redacted",
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
        profile: { type: "object", properties: { name: { type: "string" }, source: { type: "string" }, exists: { type: "boolean" } } },
        store: { type: "string" },
        profiles: { type: "array", items: { type: "string" } },
        read: { type: ["object", "null"] },
        visitor: { type: ["object", "null"] },
        environment: { type: "array", items: { type: "string" } },
      },
      ["profile", "store", "read", "visitor"],
    ),
    examples: ["arcopolis auth status --json"],
    async run(ctx) {
      const resolved = await ctx.store.resolved();
      const credentials = await ctx.store.credentials();
      const data: AuthStatusData = {
        profile: resolved.profile,
        store: storeLabel(ctx),
        profiles: Object.keys(credentials.profiles).sort(),
        read: summarizeReadKey(resolved),
        visitor: summarizeVisitor(resolved),
        environment: setCredentialEnvNames(ctx.env),
      };
      const next: NextStep[] =
        data.read.configured || data.visitor.configured
          ? []
          : [{ command: "arcopolis setup --json", why: "Get credentials with one human approval", humanDecision: false }];
      return { data, next };
    },
    renderHuman: renderAuthStatusHuman,
  }),
  defineCommand({
    name: "auth import",
    summary: "Store an existing key (from stdin, an environment variable, or a hidden prompt) at 0600",
    description:
      "Keys are never accepted as arguments. The key is checked against ^agnts_[0-9a-f]{64}$, saved to the credential " +
      "store at 0600 for the current API origin, and verified with one GET /v1 unless --no-verify. A key the API " +
      "rejects (exit 3) is not kept.",
    phase: 1,
    credentials: "none",
    confirmation: "none",
    network: "data (1 GET /v1 unless --no-verify)",
    effects: { writes: ["credential_store"], spends: ["rateLimit"] },
    flags: [
      { name: "stdin", type: "boolean", description: "Read the key from stdin." },
      { name: "from-env", type: "string", placeholder: "NAME", description: "Read the key from this environment variable." },
      { name: "visitor", type: "boolean", description: "Import a visitor drive key (needs --agent)." },
      { name: "agent", type: "string", placeholder: "ID", description: "Visitor agent id." },
      { name: "world", type: "string", placeholder: "ID", description: "Visitor world id." },
      { name: "no-verify", type: "boolean", description: "Skip the GET /v1 verification." },
    ],
    positionals: [],
    errors: [
      "INVALID_KEY_FORMAT",
      "INPUT_REQUIRED",
      "PROMPT_TIMEOUT",
      "INVALID_API_KEY",
      "KEY_REVOKED",
      "KEY_DISABLED",
      "STATE_LOCKED",
      "STORE_NOT_WRITABLE",
      "STORE_NOT_IGNORED",
      "STORE_PATH_SYMLINK",
      "GITIGNORE_SYMLINK",
      "MISSING_ARGUMENT",
    ],
    exitCodes: [0, 1, 2, 3, 4, 10, 13],
    outputSchema: objectSchema(
      {
        profile: { type: "string" },
        kind: { enum: ["read", "visitor"] },
        keyPrefix: { type: "string" },
        source: { enum: ["stdin", "env", "prompt"] },
        store: { type: "string" },
        stored: { type: "boolean" },
        verified: { type: "boolean" },
        verification: { type: "object" },
      },
      ["profile", "kind", "keyPrefix", "stored", "verified"],
    ),
    examples: [
      "<secret-manager command> | arcopolis auth import --stdin --json",
      "arcopolis auth import --from-env ARCOPOLIS_API_KEY --json",
      "arcopolis auth import --visitor --agent <agentId> --stdin",
    ],
    async run(ctx) {
      const visitor = flagBoolean(ctx.flags, "visitor");
      const agentId = flagString(ctx.flags, "agent");
      const worldId = flagString(ctx.flags, "world");
      if (!visitor && (agentId !== undefined || worldId !== undefined)) {
        throw usageError("--agent and --world apply only with --visitor.");
      }
      if (visitor) {
        if (agentId === undefined) {
          throw new CliError("MISSING_ARGUMENT", "--visitor needs --agent <agentId> (shown on the portal after registering).", {
            humanDecision: false,
          });
        }
        assertAgentId(agentId, "--agent");
        if (worldId !== undefined) assertAgentId(worldId, "--world");
      }
      const kind: ImportKind = visitor ? "visitor" : "read";
      const { key, source } = await readKeyInput(ctx, visitor ? "Paste the visitor drive key (input is hidden):" : "Paste the read key (input is hidden):");
      const summary = await importKey(ctx, {
        kind,
        key,
        source,
        agentId: agentId ?? null,
        worldId: worldId ?? null,
        verify: !flagBoolean(ctx.flags, "no-verify"),
      });
      if (summary.stored) envOverrideWarnings(ctx, kind);
      const next: NextStep[] =
        kind === "read"
          ? [{ command: "arcopolis agents list --per-page 5 --json", why: "First read", humanDecision: false }]
          : [{ command: "arcopolis visitor status --json", why: "Cached visitor state (no network)", humanDecision: false }];
      return { data: summary, next };
    },
    renderHuman: renderImportHuman,
  }),
  defineCommand({
    name: "auth forget",
    summary: "Delete local credentials for a profile (keys stay valid on the server)",
    description:
      "Removes the profile from credentials.json after a TTY y/N or --yes. This does not revoke anything: the keys " +
      "keep working until they are deleted or rotated in the developer portal.",
    phase: 1,
    credentials: "none",
    confirmation: "yes",
    network: "none",
    effects: { writes: ["credential_store"], spends: [] },
    flags: [{ name: "yes", type: "boolean", humanDecision: true, description: "Delete without the y/N prompt." }],
    positionals: [],
    errors: ["CONFIRMATION_REQUIRED", "CONFIRMATION_DECLINED", "STATE_LOCKED", "INSECURE_CREDENTIAL_FILE"],
    exitCodes: [0, 1, 2, 3, 10, 13],
    outputSchema: objectSchema(
      {
        profile: { type: "string" },
        removed: { type: "boolean" },
        removedKeys: { type: "array" },
        keysStillValid: { type: "boolean" },
        portal: { type: "string" },
        message: { type: "string" },
      },
      ["profile", "removed", "keysStillValid", "portal", "message"],
    ),
    examples: ["arcopolis auth forget", "arcopolis auth forget --profile work --yes --json"],
    async run(ctx) {
      const profile = await resolveImportProfile(ctx);
      const current = ctx.mode.demo ? await ctx.store.credentials() : await ctx.store.credentialStore.readCredentials();
      const record = current.profiles[profile];
      const removedKeys: ForgetData["removedKeys"] = [];
      if (record?.readKey?.key) removedKeys.push({ kind: "read", keyPrefix: redactKey(record.readKey.key) });
      if (record?.visitor?.key) removedKeys.push({ kind: "visitor", keyPrefix: redactKey(record.visitor.key) });
      const stillValid = `The keys stay valid on the server; delete or rotate them in the portal: ${PORTAL_ORIGIN}`;
      if (!record) {
        const data: ForgetData = {
          profile,
          removed: false,
          removedKeys: [],
          keysStillValid: true,
          portal: PORTAL_ORIGIN,
          message: `No local credentials for profile "${profile}". Nothing was deleted.`,
        };
        return { data };
      }
      if (ctx.mode.demo) {
        const data: ForgetData = {
          profile,
          removed: false,
          removedKeys,
          keysStillValid: true,
          portal: PORTAL_ORIGIN,
          message: `Demo mode: would delete the local credentials for profile "${profile}". Nothing was written. ${stillValid}`,
          demo: true,
        };
        return { data };
      }
      if (!flagBoolean(ctx.flags, "yes")) {
        if (!ctx.mode.interactive) {
          throw new CliError("CONFIRMATION_REQUIRED", `Deleting the local credentials for profile "${profile}" needs a confirmation.`, {
            hint: "Add --yes only when the human asked to delete the local credentials. The keys stay valid on the server either way.",
            humanDecision: true,
            data: { profile, removedKeys },
          });
        }
        const yes = await ctx.confirm(`Delete the local credentials for profile "${profile}"? The keys stay valid on the server.`);
        if (!yes) {
          throw new CliError("CONFIRMATION_DECLINED", "Nothing was deleted.", { humanDecision: true });
        }
      }
      await ctx.store.credentialStore.updateCredentials((file: CredentialsFile) => {
        delete file.profiles[profile];
      });
      ctx.effects.write("credential_store");
      envOverrideWarnings(ctx, "all");
      const data: ForgetData = {
        profile,
        removed: true,
        removedKeys,
        keysStillValid: true,
        portal: PORTAL_ORIGIN,
        message: `Deleted the local credentials for profile "${profile}". ${stillValid}`,
      };
      return {
        data,
        next: [{ command: "arcopolis portal", why: "Delete or rotate the keys on the server (a human step)", humanDecision: true }],
      };
    },
    renderHuman: renderForgetHuman,
  }),
];
