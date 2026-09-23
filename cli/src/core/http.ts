/**
 * HTTP transport (plan §3.4), a faithful port of the starter client
 * (`examples/arcopolis-starter/node/client.mjs`) with the CLI's stricter
 * rules: no automatic retries, manual redirects, JSON parsed only on a JSON
 * content type, and stored keys sent only to the origin they were saved for.
 */
import { joinUrl, normalizeBase, stripV1, type ResolvedBase } from "./bases.js";
import { CliError, fromApiError, type ErrorSurface } from "./errors.js";
import type { Effects, NetworkPlane } from "./output.js";
import { redact } from "./redact.js";

/** The fetch signature the transport needs; inject a fake in tests or demo mode. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** What a request is for; picks the default timeout. */
export type RequestPurpose = "control" | "poll" | "read" | "heartbeat" | "act";

/** Default timeouts (plan §3.4). `--timeout` overrides all of them. */
export const DEFAULT_TIMEOUTS_MS: Readonly<Record<RequestPurpose, number>> = {
  control: 30_000,
  poll: 15_000,
  read: 20_000,
  heartbeat: 30_000,
  act: 45_000,
};

/** Maximum characters of a non-JSON body echoed (redacted) in error details. */
export const NON_JSON_EXCERPT_CHARS = 200;

/** Where a key came from. Only `store` keys are origin-bound. */
export type KeySource = "env" | "legacy_env" | "store" | "demo";

/** A key the transport may attach as `X-API-Key`. */
export interface TransportKey {
  value: string;
  source: KeySource;
  /** For `store` keys: the origin the key was saved for (e.g. `https://api.arcopolis.ai`). */
  origin?: string | null;
}

export interface TransportOptions {
  plane: NetworkPlane;
  base: ResolvedBase;
  key?: TransportKey | null;
  userAgent: string;
  fetchImpl?: FetchLike;
  /** Overrides every per-purpose default (from `--timeout`). */
  timeoutMs?: number | null;
  effects?: Effects;
  /** Redacted `--verbose` trace line sink (stderr). */
  trace?: (line: string) => void;
  /** Called once per request to a custom host; the CLI prints the host on stderr. */
  onCustomHost?: (host: string) => void;
  now?: () => Date;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: "GET" | "POST";
  /** Undefined and null values are dropped (no stray query parameters). */
  query?: Record<string, QueryValue | readonly QueryValue[]>;
  /** JSON body; only allowed on POST. Serialized with JSON.stringify. */
  body?: unknown;
  idempotencyKey?: string;
  purpose?: RequestPurpose;
  timeoutMs?: number;
  /** Timeouts, network errors, and 409 fallbacks become unresolved-write codes. Defaults to `method === "POST"`. */
  write?: boolean;
  /** Attach `X-API-Key` (default true when the client has a key). */
  auth?: boolean;
  /** Require the `{data: …}` envelope (default true). `GET /v1` metadata is unwrapped: pass false. */
  envelope?: boolean;
}

/** A successful (2xx) JSON response. */
export interface ApiResponse<T = unknown> {
  status: number;
  url: string;
  headers: Headers;
  /** The full parsed JSON body. */
  body: Record<string, unknown>;
  /** `body.data` when the envelope is present, else the whole body. */
  data: T;
  /** `body.meta` when present. */
  meta: Record<string, unknown> | null;
  retryAfterSeconds: number | null;
}

/** `arcopolis-cli/<version> node/<v> <platform>-<arch>` (+ ` mcp`). */
export function buildUserAgent(version: string, mcp = false): string {
  const base = `arcopolis-cli/${version} node/${process.versions.node} ${process.platform}-${process.arch}`;
  return mcp ? `${base} mcp` : base;
}

/** Parses `Retry-After` as delta seconds or an HTTP date. Returns null when absent or invalid. */
export function parseRetryAfter(value: string | null | undefined, now: Date = new Date()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed));
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now.getTime()) / 1000)) : null;
}

/** True for `application/json` and `application/*+json` content types. */
export function isJsonContentType(contentType: string | null): boolean {
  return contentType !== null && /^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType.trim());
}

function buildQuery(query: RequestOptions["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [name, raw] of Object.entries(query)) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values as QueryValue[]) {
      if (value === undefined || value === null) continue;
      params.append(name, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * One bounded HTTP client per plane. Never retries; the only repeated
 * requests are the ones a command makes explicitly.
 */
export class HttpClient {
  readonly plane: NetworkPlane;
  readonly base: ResolvedBase;
  private readonly key: TransportKey | null;
  private readonly fetchImpl: FetchLike;
  private readonly options: TransportOptions;
  private count = 0;

  constructor(options: TransportOptions) {
    // Defensive: HTTPS only (HTTP only on loopback), whatever built the base.
    normalizeBase(options.base.url, options.plane === "data" ? "ARCOPOLIS_API_BASE" : "ARCOPOLIS_DEVELOPER_BASE");
    this.options = options;
    this.plane = options.plane;
    this.base = options.base;
    this.key = options.key ?? null;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Requests sent by this client. */
  get requestCount(): number {
    return this.count;
  }

  /** True when a key is attached and would be sent to this base. */
  get hasUsableKey(): boolean {
    return this.key !== null && this.keyAllowedForBase();
  }

  /** GET helper. */
  async get<T = unknown>(path: string, query?: RequestOptions["query"], options: Omit<RequestOptions, "method" | "query" | "body"> = {}): Promise<ApiResponse<T>> {
    return this.request<T>(path, { ...options, method: "GET", query });
  }

  /** POST helper; the body is always JSON. */
  async post<T = unknown>(path: string, body: unknown, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<ApiResponse<T>> {
    return this.request<T>(path, { ...options, method: "POST", body });
  }

  private keyAllowedForBase(): boolean {
    if (!this.key) return false;
    if (this.key.source !== "store") return true;
    if (this.base.kind === "custom") return false;
    return typeof this.key.origin === "string" && this.key.origin === this.base.origin;
  }

  /**
   * Sends one request. Throws a {@link CliError} for every non-2xx, non-JSON,
   * redirect, timeout, or network failure.
   */
  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const method = options.method ?? "GET";
    const write = options.write ?? method === "POST";
    const now = this.options.now ?? (() => new Date());
    const surface: ErrorSurface = this.plane;
    const relative = this.plane === "data" ? stripV1(path) : path;
    if (method === "GET" && options.body !== undefined) {
      throw new CliError("INTERNAL", "A GET request cannot carry a body.");
    }
    const url = `${joinUrl(this.base.url, relative)}${buildQuery(options.query)}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.options.userAgent,
    };
    const wantsAuth = options.auth ?? true;
    if (wantsAuth && this.key) {
      if (!this.keyAllowedForBase()) {
        throw new CliError(
          "STORED_KEY_ORIGIN_MISMATCH",
          `The stored key was saved for ${this.key.origin ?? "another origin"} and is never sent to ${this.base.origin}.`,
          {
            hint: "Only a key supplied in the environment can be used with a custom base.",
            humanDecision: true,
          },
        );
      }
      headers["X-API-Key"] = this.key.value;
    }
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    const purpose = options.purpose ?? (this.plane === "control" ? "control" : method === "GET" ? "read" : "act");
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUTS_MS[purpose];
    const signal = AbortSignal.timeout(timeoutMs);
    const init: RequestInit = { method, headers, redirect: "manual", signal };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);

    if (this.base.kind === "custom") this.options.onCustomHost?.(this.base.host);
    this.count += 1;
    this.options.effects?.request(this.plane);
    if (this.plane === "data" && headers["X-API-Key"]) this.options.effects?.spend("rateLimit", 1);
    const started = Date.now();
    const trace = (text: string): void => this.options.trace?.(redact(text));
    trace(`→ ${method} ${url}`);

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw this.transportFailure(error, signal, write, surface, now);
    }

    const contentType = response.headers.get("content-type");
    const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"), now());
    const elapsed = Date.now() - started;

    if (response.status >= 300 && response.status < 400) {
      trace(`← ${response.status} redirect rejected ${elapsed}ms`);
      await response.body?.cancel().catch(() => undefined);
      throw new CliError(
        "REDIRECT_REJECTED",
        "The API redirected this request. Use the canonical API base; credentials were not forwarded.",
        { httpStatus: response.status, surface: "edge", humanDecision: false },
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw this.transportFailure(error, signal, write, surface, now);
    }

    if (!isJsonContentType(contentType)) {
      const excerpt = redact(text.slice(0, NON_JSON_EXCERPT_CHARS));
      const edge = response.status === 403 && text.includes("error code: 1010");
      const code = edge ? "EDGE_BLOCKED" : "NON_JSON_RESPONSE";
      trace(`← ${response.status} ${contentType ?? "no content-type"} ${code} ${elapsed}ms`);
      throw new CliError(
        code,
        edge
          ? "The CDN edge blocked this request (error code 1010) before it reached the API."
          : `The API returned a non-JSON response (HTTP ${response.status}).`,
        {
          httpStatus: response.status,
          surface: "edge",
          humanDecision: false,
          details: { status: response.status, contentType, excerpt },
        },
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      trace(`← ${response.status} ${contentType} NON_JSON_RESPONSE ${elapsed}ms`);
      throw new CliError("NON_JSON_RESPONSE", `The API returned malformed JSON (HTTP ${response.status}).`, {
        httpStatus: response.status,
        surface: "edge",
        humanDecision: false,
        details: { status: response.status, contentType, excerpt: redact(text.slice(0, NON_JSON_EXCERPT_CHARS)) },
      });
    }

    const body = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;

    if (!response.ok) {
      const errorObject =
        body && body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : {};
      const { code, message, ...extra } = errorObject;
      const cliError = fromApiError({
        httpStatus: response.status,
        code: typeof code === "string" ? code : null,
        message: typeof message === "string" ? message : null,
        extra,
        surface,
        write,
        retryAfterSeconds,
        now: now(),
      });
      trace(`← ${response.status} ${cliError.code} ${elapsed}ms`);
      throw cliError;
    }

    const wantsEnvelope = options.envelope ?? true;
    if (!body || (wantsEnvelope && !Object.hasOwn(body, "data"))) {
      trace(`← ${response.status} INVALID_RESPONSE ${elapsed}ms`);
      throw new CliError("INVALID_RESPONSE", "The API response did not contain the expected data envelope.", {
        httpStatus: response.status,
        surface,
        humanDecision: false,
      });
    }
    trace(`← ${response.status} ${elapsed}ms`);
    const meta = body.meta && typeof body.meta === "object" ? (body.meta as Record<string, unknown>) : null;
    return {
      status: response.status,
      url: redact(url),
      headers: response.headers,
      body,
      data: (wantsEnvelope ? body.data : body) as T,
      meta,
      retryAfterSeconds,
    };
  }

  private transportFailure(
    error: unknown,
    signal: AbortSignal,
    write: boolean,
    surface: ErrorSurface,
    now: () => Date,
  ): CliError {
    if (error instanceof CliError) return error;
    const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
    const timedOut = signal.aborted || name === "TimeoutError" || name === "AbortError";
    this.options.trace?.(`← ${timedOut ? "timeout" : "network error"}`);
    if (write) {
      return new CliError(
        timedOut ? "WRITE_TIMEOUT" : "WRITE_NETWORK_ERROR",
        timedOut
          ? "The write timed out; it may or may not have happened. Keep the pending state and idempotency key."
          : "The write could not finish; it may or may not have happened. No automatic retry was sent.",
        { surface, now: now() },
      );
    }
    return new CliError(
      timedOut ? "TIMEOUT" : "NETWORK_ERROR",
      timedOut ? "The request timed out." : "The request could not finish. No automatic retry was sent.",
      { surface, humanDecision: false, now: now() },
    );
  }
}
