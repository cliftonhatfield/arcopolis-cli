/**
 * API bases and host policy (plan §3.5). `normalizeBase` is a port of the
 * starter's (`examples/arcopolis-starter/node/client.mjs`), so the pending
 * state file's `baseUrl` stays byte-compatible with the starter.
 */
import { CliError } from "./errors.js";

export const DEFAULT_API_BASE = "https://api.arcopolis.ai/v1";
export const DEFAULT_DEVELOPER_BASE = "https://developers.arcologylabs.com/_developer";
export const CANONICAL_API_HOST = "api.arcopolis.ai";
export const CANONICAL_DEVELOPER_HOST = "developers.arcologylabs.com";
export const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];
/** Portal origin (human pages such as /start/read). */
export const PORTAL_ORIGIN = "https://developers.arcologylabs.com";

export type BaseKind = "canonical" | "loopback" | "custom";
export type BaseSource = "env" | "legacy_env" | "default" | "profile";
export type BasePlane = "data" | "control";

/** A validated, normalized base URL and where it came from. */
export interface ResolvedBase {
  /** Normalized href without a trailing slash, e.g. `https://api.arcopolis.ai/v1`. */
  url: string;
  /** `https://api.arcopolis.ai` */
  origin: string;
  /** Hostname as the URL parser reports it (`[::1]` keeps brackets). */
  host: string;
  kind: BaseKind;
  source: BaseSource;
  /** Environment variable name when `source` is `env` or `legacy_env`. */
  variable?: string;
}

/**
 * Normalizes a base exactly like the starter: HTTPS only (HTTP only on
 * loopback), no credentials, query, or fragment; trailing slashes removed.
 * Throws `INVALID_BASE` (exit 2).
 */
export function normalizeBase(value: string, name = "ARCOPOLIS_API_BASE"): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidBase(name);
  }
  const local = LOOPBACK_HOSTS.includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw invalidBase(name);
  }
  return url.href.replace(/\/+$/, "");
}

function invalidBase(name: string): CliError {
  return new CliError(
    "INVALID_BASE",
    `${name} must be an HTTPS API URL (HTTP is allowed only on localhost), without credentials, query, or fragment.`,
    { humanDecision: false },
  );
}

/** Canonical for its plane, loopback (emulators), or custom. */
export function classifyBase(url: string, plane: BasePlane): BaseKind {
  const parsed = new URL(url);
  if (LOOPBACK_HOSTS.includes(parsed.hostname)) return "loopback";
  const canonical = plane === "data" ? CANONICAL_API_HOST : CANONICAL_DEVELOPER_HOST;
  if (parsed.protocol === "https:" && parsed.hostname === canonical && (parsed.port === "" || parsed.port === "443")) {
    return "canonical";
  }
  return "custom";
}

/** True when `ARCOPOLIS_ALLOW_CUSTOM_BASE` opts in to a non-canonical HTTPS host. */
export function customBaseAllowed(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.ARCOPOLIS_ALLOW_CUSTOM_BASE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Validates one base value for a plane and applies the custom-host rule:
 * any non-canonical, non-loopback host needs `ARCOPOLIS_ALLOW_CUSTOM_BASE=1`
 * (`CUSTOM_BASE_NOT_ALLOWED`, exit 2).
 */
export function checkBase(
  value: string,
  plane: BasePlane,
  source: BaseSource,
  env: Readonly<Record<string, string | undefined>>,
  variable?: string,
): ResolvedBase {
  const name = variable ?? (plane === "data" ? "ARCOPOLIS_API_BASE" : "ARCOPOLIS_DEVELOPER_BASE");
  const url = normalizeBase(value, name);
  const parsed = new URL(url);
  const kind = classifyBase(url, plane);
  if (kind === "custom" && !customBaseAllowed(env)) {
    throw new CliError(
      "CUSTOM_BASE_NOT_ALLOWED",
      `${name} points at ${parsed.host}, which is not a canonical Arcopolis host.`,
      {
        hint: "Set ARCOPOLIS_ALLOW_CUSTOM_BASE=1 to use it. Stored keys are never sent to a custom host.",
        humanDecision: true,
      },
    );
  }
  return {
    url,
    origin: parsed.origin,
    host: parsed.hostname,
    kind,
    source,
    ...(variable ? { variable } : {}),
  };
}

/** Warning sink used while resolving legacy variables. */
export type WarnFn = (code: string, message: string) => void;

/**
 * Data-plane base: `ARCOPOLIS_API_BASE` → legacy `AGNTS_API_BASE_URL` (with
 * a deprecation warning) → default. Project files can never set a base.
 */
export function resolveApiBase(env: Readonly<Record<string, string | undefined>>, warn?: WarnFn): ResolvedBase {
  const primary = env.ARCOPOLIS_API_BASE?.trim();
  if (primary) return checkBase(primary, "data", "env", env, "ARCOPOLIS_API_BASE");
  const legacy = env.AGNTS_API_BASE_URL?.trim();
  if (legacy) {
    warn?.(
      "DEPRECATED_ENV",
      "AGNTS_API_BASE_URL is deprecated; rename it to ARCOPOLIS_API_BASE.",
    );
    return checkBase(legacy, "data", "legacy_env", env, "AGNTS_API_BASE_URL");
  }
  return checkBase(DEFAULT_API_BASE, "data", "default", env);
}

/** Control-plane base: `ARCOPOLIS_DEVELOPER_BASE` → default. */
export function resolveDeveloperBase(env: Readonly<Record<string, string | undefined>>): ResolvedBase {
  const value = env.ARCOPOLIS_DEVELOPER_BASE?.trim();
  if (value) return checkBase(value, "control", "env", env, "ARCOPOLIS_DEVELOPER_BASE");
  return checkBase(DEFAULT_DEVELOPER_BASE, "control", "default", env);
}

/**
 * Strips one leading `/v1` from a user-supplied data-plane path, so the base
 * (which already ends in `/v1`) is never doubled: `/v1/agents` → `/agents`,
 * `/v1` → `/`, `/v1?x=1` → `/?x=1`. Adds a leading slash when missing.
 */
export function stripV1(path: string): string {
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  const match = /^\/v1(?=$|[/?#])/.exec(withSlash);
  if (!match) return withSlash;
  const rest = withSlash.slice(3);
  if (rest === "" || rest.startsWith("?") || rest.startsWith("#")) return `/${rest}`;
  return rest;
}

/**
 * Joins a normalized base and a relative path that begins with exactly one
 * slash. Throws `INVALID_PATH` (exit 2) for anything else.
 */
export function joinUrl(base: string, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new CliError("INVALID_PATH", "Use a relative API path beginning with one slash.", { humanDecision: false });
  }
  return `${base}${path === "/" ? "" : path}`;
}

/** Origin of the data base without its path, used for static files such as the CLI manifest. */
export function originOf(url: string): string {
  return new URL(url).origin;
}
