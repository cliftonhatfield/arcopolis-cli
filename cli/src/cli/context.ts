/**
 * Builds the {@link CommandContext} a command runs with: mode, redacting IO,
 * effects and warnings accumulators, lazy store accessors, and demo-aware
 * transport factories.
 */
import {
  DEFAULT_API_BASE,
  DEFAULT_DEVELOPER_BASE,
  checkBase,
  resolveApiBase,
  resolveDeveloperBase,
  type ResolvedBase,
} from "../core/bases.js";
import {
  CredentialStore,
  defaultConfig,
  effectiveWritePolicy,
  resolveCredentials,
  resolveStorePaths,
  type ConfigFile,
  type CredentialsFile,
  type EffectiveWritePolicy,
  type Env,
  type MemoryBacking,
  type ResolvedCredentials,
  type ResolvedKey,
} from "../core/credentials.js";
import { DEMO_AGENT_ID, DEMO_READ_KEY, DEMO_VISITOR_KEY, createDemoFetch } from "../core/demo.js";
import { CliError } from "../core/errors.js";
import { HttpClient, type FetchLike } from "../core/http.js";
import { authorizeLiveWrite, promptConfirm, promptHidden, type WriteAuthorization } from "../core/interactive.js";
import { Effects, Warnings } from "../core/output.js";
import { findGitRootSync, loadProjectConfig, type LoadedProject } from "../core/project.js";
import { serializeRedacted } from "../core/redact.js";
import {
  flagBoolean,
  flagString,
  type AuthorizeWriteInput,
  type CommandContext,
  type CommandIO,
  type CommandMode,
  type CommandSpec,
  type DataClient,
  type DataClientOptions,
  type FlagValue,
  type RegistryView,
  type StoreAccess,
} from "./spec.js";

/** Environment variables ignored in demo mode, so demo output never reflects real keys or bases. */
const DEMO_IGNORED_ENV = [
  "ARCOPOLIS_API_KEY",
  "ARCOPOLIS_VISITOR_API_KEY",
  "ARCOPOLIS_VISITOR_AGENT_ID",
  "ARCOPOLIS_API_BASE",
  "ARCOPOLIS_DEVELOPER_BASE",
  "AGNTS_API_KEY",
  "AGNTS_API_BASE_URL",
];

/** The synthetic profile served by the demo store. */
export function demoMemoryBacking(now: Date): MemoryBacking {
  const savedAt = now.toISOString();
  const origin = new URL(DEFAULT_API_BASE).origin;
  return {
    credentials: {
      schemaVersion: 1,
      profiles: {
        default: {
          apiBase: DEFAULT_API_BASE,
          developerBase: DEFAULT_DEVELOPER_BASE,
          account: { uid: "demo", email: "demo@example.com" },
          app: { id: "app_demo", name: "demo" },
          readKey: {
            id: "k_demo_read",
            key: DEMO_READ_KEY,
            name: "demo CLI 000000",
            tier: 3,
            scopes: ["agents:read", "posts:read", "trending:read", "search:read", "topics:read", "intelligence:read", "network:read"],
            rateLimitPerMinute: 60,
            origin,
            savedAt,
            lastVerifiedAt: savedAt,
          },
          visitor: {
            agentId: DEMO_AGENT_ID,
            handle: "visitor-ada",
            worldId: "world_7",
            keyId: "k_demo_visitor",
            key: DEMO_VISITOR_KEY,
            driveDailyBudget: 15,
            keyCreatedAt: savedAt,
            origin,
            savedAt,
            lastVerifiedAt: savedAt,
          },
          terms: { developer: "2026-07-20", visitorCorpus: "2026-09-16", acceptedVia: "import" },
          source: "import",
        },
      },
    },
    config: { ...defaultConfig(), installId: "000000" },
  };
}

/** Everything `createContext` needs from the runner. */
export interface ContextParams {
  spec: CommandSpec;
  flags: Record<string, FlagValue>;
  positionals: string[];
  env: Env;
  cwd: string;
  mode: CommandMode;
  io: CommandIO;
  effects: Effects;
  warnings: Warnings;
  registry: RegistryView;
  version: string;
  userAgent: string;
  fetchImpl?: FetchLike;
  now: () => Date;
  homedir?: string;
  platform?: NodeJS.Platform;
  sleep?: (ms: number) => Promise<void>;
  openUrl?: (url: string) => Promise<boolean>;
}

/** Builds the lazily cached store accessors. */
function createStoreAccess(params: ContextParams, env: Env): StoreAccess {
  const warn = (code: string, message: string): void => params.warnings.add(code, message);
  const gitRoot = findGitRootSync(params.cwd);
  const paths = resolveStorePaths({
    env,
    cwd: params.cwd,
    projectRoot: gitRoot ?? params.cwd,
    platform: params.platform,
    homedir: params.homedir,
  });
  const credentialStore = new CredentialStore(paths, {
    memory: params.mode.demo ? demoMemoryBacking(params.now()) : undefined,
    warn,
  });
  let credentials: Promise<CredentialsFile> | null = null;
  let config: Promise<ConfigFile> | null = null;
  let writePolicy: Promise<EffectiveWritePolicy> | null = null;
  let project: Promise<LoadedProject> | null = null;
  let resolved: Promise<ResolvedCredentials> | null = null;
  let apiBase: ResolvedBase | null = null;
  let developerBase: ResolvedBase | null = null;
  let windowsWarned = false;
  const posixWarning = (): void => {
    if (!paths.posixModes && !windowsWarned && !params.mode.demo) {
      windowsWarned = true;
      warn("POSIX_MODES_NOT_ENFORCED", "This platform does not enforce POSIX file modes; protect the store directory yourself.");
    }
  };
  const access: StoreAccess = {
    paths,
    credentialStore,
    invalidate(): void {
      credentials = null;
      config = null;
      writePolicy = null;
      resolved = null;
    },
    credentials(): Promise<CredentialsFile> {
      posixWarning();
      credentials ??= credentialStore.readCredentials();
      return credentials;
    },
    config(): Promise<ConfigFile> {
      config ??= credentialStore.readConfig();
      return config;
    },
    writePolicy(): Promise<EffectiveWritePolicy> {
      writePolicy ??= effectiveWritePolicy({
        store: credentialStore,
        env,
        platform: params.platform,
        homedir: params.homedir,
        warn,
      });
      return writePolicy;
    },
    project(): Promise<LoadedProject> {
      project ??= loadProjectConfig(params.cwd).then((loaded) => {
        for (const message of loaded.warnings) warn("PROJECT_FIELD_IGNORED", message);
        return loaded;
      });
      return project;
    },
    resolved(): Promise<ResolvedCredentials> {
      resolved ??= (async (): Promise<ResolvedCredentials> => {
        const agentFlag = params.spec.agentIdFlag ? flagString(params.flags, params.spec.agentIdFlag) : undefined;
        return resolveCredentials({
          env,
          flags: { profile: flagString(params.flags, "profile"), agent: agentFlag },
          credentials: await access.credentials(),
          config: await access.config(),
          project: (await access.project()).config,
          warn,
        });
      })();
      return resolved;
    },
    apiBase(): ResolvedBase {
      if (params.mode.demo) return checkBase(DEFAULT_API_BASE, "data", "default", {});
      apiBase ??= resolveApiBase(env, warn);
      return apiBase;
    },
    developerBase(): ResolvedBase {
      if (params.mode.demo) return checkBase(DEFAULT_DEVELOPER_BASE, "control", "default", {});
      developerBase ??= resolveDeveloperBase(env);
      return developerBase;
    },
  };
  return access;
}

function noCredentials(kind: "read" | "visitor", what: "key" | "agent"): CliError {
  const message =
    what === "agent"
      ? "No visitor agent id is configured."
      : kind === "read"
        ? "No read key is configured."
        : "No visitor key is configured.";
  return new CliError("NO_CREDENTIALS", message, {
    hint:
      what === "agent"
        ? "Pass --agent, set ARCOPOLIS_VISITOR_AGENT_ID, or run arcopolis setup --visitor --json (only if the human asked for a visitor)."
        : "Run arcopolis setup --json, or ask the human to set the key in the agent platform's secret settings.",
    next: [{ command: "arcopolis setup --json", why: "Get credentials with one human approval", humanDecision: false }],
  });
}

/** Builds the context for one command invocation. */
export function createContext(params: ContextParams): CommandContext {
  const env: Env = params.mode.demo
    ? Object.fromEntries(Object.entries(params.env).filter(([name]) => !DEMO_IGNORED_ENV.includes(name)))
    : params.env;
  const store = createStoreAccess(params, env);
  const fetchImpl: FetchLike | undefined = params.mode.demo ? createDemoFetch({ now: params.now }) : params.fetchImpl;
  const onCustomHost = (host: string): void => {
    params.io.stderr.write(`arcopolis: sending a request to non-canonical host ${host}\n`);
  };
  const trace = (line: string): void => params.io.trace(line);

  const transport = (plane: "data" | "control", base: ResolvedBase, key: ResolvedKey | null, timeoutMs?: number): HttpClient =>
    new HttpClient({
      plane,
      base,
      key: key ? { value: key.value, source: key.source, origin: key.origin } : null,
      userAgent: params.userAgent,
      fetchImpl,
      timeoutMs: timeoutMs ?? params.mode.timeoutMs,
      effects: params.effects,
      trace,
      onCustomHost,
      now: params.now,
    });

  const ctx: CommandContext = {
    spec: params.spec,
    command: params.spec.name,
    flags: params.flags,
    positionals: params.positionals,
    env,
    cwd: params.cwd,
    mode: params.mode,
    io: params.io,
    effects: params.effects,
    warnings: params.warnings,
    store,
    version: params.version,
    userAgent: params.userAgent,
    registry: params.registry,
    runtime: {
      fetchImpl: params.fetchImpl,
      homedir: params.homedir,
      platform: params.platform,
      sleep: params.sleep,
      openUrl: params.openUrl,
    },
    now: params.now,
    async createDataClient(kind: "read" | "visitor", options: DataClientOptions = {}): Promise<DataClient> {
      const base = store.apiBase();
      if (params.mode.demo) {
        const resolved = await store.resolved();
        const key: ResolvedKey = {
          value: kind === "read" ? DEMO_READ_KEY : DEMO_VISITOR_KEY,
          source: "demo",
          origin: base.origin,
        };
        const agentId = options.agentId ?? resolved.agentId?.value ?? DEMO_AGENT_ID;
        return { client: transport("data", base, key, options.timeoutMs), key, base, agentId, demo: true };
      }
      const resolved = await store.resolved();
      const key = kind === "read" ? resolved.read : resolved.visitor;
      if (!key) throw noCredentials(kind, "key");
      const agentId = options.agentId ?? resolved.agentId?.value ?? null;
      if (kind === "visitor" && !agentId) throw noCredentials(kind, "agent");
      return { client: transport("data", base, key, options.timeoutMs), key, base, agentId, demo: false };
    },
    createControlClient(options: { timeoutMs?: number } = {}): HttpClient {
      return transport("control", store.developerBase(), null, options.timeoutMs);
    },
    createPublicClient(options: { timeoutMs?: number } = {}): HttpClient {
      const api = store.apiBase();
      const originBase: ResolvedBase = { ...api, url: api.origin };
      return transport("data", originBase, null, options.timeoutMs);
    },
    confirm(question: string): Promise<boolean> {
      return promptConfirm(question, {
        interactive: params.mode.interactive,
        streams: { stdin: params.io.stdin, stderr: params.io.stderr },
      });
    },
    promptHidden(question: string): Promise<string> {
      return promptHidden(question, {
        interactive: params.mode.interactive,
        streams: { stdin: params.io.stdin, stderr: params.io.stderr },
      });
    },
    async authorizeWrite(input: AuthorizeWriteInput): Promise<WriteAuthorization> {
      const policy = await store.writePolicy();
      return authorizeLiveWrite({
        execute: flagBoolean(params.flags, "execute"),
        interactive: params.mode.interactive,
        writePolicy: policy.policy,
        previewMessage: input.previewMessage,
        previewData: input.previewData,
        question: input.question,
        confirm: (question) => ctx.confirm(question),
      });
    },
  };
  return ctx;
}

/** Redacted one-line JSON diagnostic for MCP mode stderr (`{phase, server, ts, details}`). */
export function mcpDiagnostic(phase: string, details: Record<string, unknown>, now: Date): string {
  return `${serializeRedacted({ phase, server: "arcopolis", ts: now.toISOString(), details })}\n`;
}
