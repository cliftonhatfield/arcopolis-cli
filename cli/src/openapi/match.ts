/**
 * Path handling for the bundled OpenAPI snapshot (plan §3.5 and §4
 * "`api get`"): normalizing a user-supplied API path (one leading `/v1`
 * stripped, never doubled), matching it against operation templates such as
 * `/agents/{id}`, and expanding templates with URL-encoded path parameters.
 *
 * Pure functions only: no network, no file access.
 */
import { CANONICAL_API_HOST } from "../core/bases.js";
import { CliError } from "../core/errors.js";

/** A user path after normalization. */
export interface NormalizedPath {
  /** Relative path without `/v1`, still percent-encoded as given (`/agents/a%2Fb`). */
  path: string;
  /** Decoded path segments (`["agents", "a/b"]`); empty for the root. */
  segments: string[];
  /** Query parameters that were part of the path (`?page=2`), in order. */
  query: Array<[string, string]>;
}

/** One segment of a compiled operation template. */
export type TemplateSegment = { kind: "literal"; value: string } | { kind: "param"; name: string };

/** An OpenAPI path template compiled for matching. */
export interface CompiledTemplate {
  /** Template as written in the snapshot, with `/v1` (`/v1/agents/{id}`). */
  template: string;
  /** Template relative to the data base, without `/v1` (`/agents/{id}`). */
  relative: string;
  segments: TemplateSegment[];
}

function invalidPath(message: string, hint?: string, details?: Record<string, unknown>): CliError {
  return new CliError("INVALID_PATH", message, {
    hint: hint ?? "Pass an API path such as /agents or /v1/agents/{id}; run arcopolis api ops to list them.",
    humanDecision: false,
    details,
  });
}

/**
 * Strips exactly one leading `/v1` segment (`/v1` → `/`, `/v1/agents` →
 * `/agents`). `/v1agents` and a second `/v1` are left alone, so a doubled
 * prefix never matches an operation.
 */
export function stripOneV1(path: string): string {
  if (path === "/v1") return "/";
  if (path.startsWith("/v1/")) return path.slice(3);
  return path;
}

function decodeSegment(raw: string, input: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw invalidPath(`The path segment "${raw}" is not valid percent-encoding.`, undefined, { path: input });
  }
  if (decoded === "." || decoded === "..") {
    throw invalidPath("Dot segments (. and ..) are not allowed in an API path.", undefined, { path: input });
  }
  return decoded;
}

/**
 * Normalizes a user-supplied API path.
 *
 * Accepts `/agents`, `agents`, `/v1/agents`, `/v1/agents/`, and a full
 * `https://` URL on one of `allowedHosts` (default: the canonical API host;
 * only its path and query are used). Rejects fragments, empty segments,
 * dot segments, and malformed percent-encoding with `INVALID_PATH` (exit 2).
 */
export function normalizeApiPath(input: string, options: { allowedHosts?: readonly string[] } = {}): NormalizedPath {
  const trimmed = input.trim();
  if (trimmed === "") throw invalidPath("The API path is empty.");
  let pathPart: string;
  let search = "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw invalidPath(`"${trimmed}" is not a valid URL or API path.`);
    }
    const allowed = options.allowedHosts ?? [CANONICAL_API_HOST];
    if (url.protocol !== "https:" || !allowed.includes(url.host)) {
      throw invalidPath(
        `Full URLs are accepted only for ${allowed.join(", ")}; pass the API path instead.`,
        "The request always goes to the configured API base, for example: arcopolis api get /agents",
        { host: url.host },
      );
    }
    if (url.username || url.password) throw invalidPath("URLs with credentials are not accepted.");
    if (url.hash) throw invalidPath("A fragment (#…) is not part of an API path.");
    pathPart = url.pathname;
    search = url.search;
  } else {
    if (trimmed.includes("#")) throw invalidPath("A fragment (#…) is not part of an API path.");
    const queryAt = trimmed.indexOf("?");
    pathPart = queryAt >= 0 ? trimmed.slice(0, queryAt) : trimmed;
    search = queryAt >= 0 ? trimmed.slice(queryAt) : "";
  }
  if (/[\s\\]/.test(pathPart)) {
    throw invalidPath("An API path cannot contain whitespace or backslashes; percent-encode them.", undefined, { path: trimmed });
  }
  let path = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  path = stripOneV1(path);
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const rawSegments = path === "/" ? [] : path.slice(1).split("/");
  if (rawSegments.some((segment) => segment === "")) {
    throw invalidPath("Empty path segments (//) are not allowed.", undefined, { path: trimmed });
  }
  const segments = rawSegments.map((segment) => decodeSegment(segment, trimmed));
  const query: Array<[string, string]> = [];
  if (search.length > 1) {
    for (const [name, value] of new URLSearchParams(search.slice(1))) query.push([name, value]);
  }
  return { path: path === "/" ? "/" : `/${rawSegments.join("/")}`, segments, query };
}

/** Compiles an OpenAPI path template (`/v1/agents/{id}`) for matching. */
export function compileTemplate(template: string): CompiledTemplate {
  const relative = stripOneV1(template.startsWith("/") ? template : `/${template}`);
  const parts = relative === "/" ? [] : relative.slice(1).split("/");
  const segments: TemplateSegment[] = parts.map((part) => {
    const param = /^\{([^{}]+)\}$/.exec(part);
    return param ? { kind: "param", name: param[1] ?? "" } : { kind: "literal", value: part };
  });
  return { template, relative, segments };
}

/**
 * Matches decoded segments against one compiled template. Returns the path
 * parameters (decoded) or null.
 */
export function matchTemplate(template: CompiledTemplate, segments: readonly string[]): Record<string, string> | null {
  if (template.segments.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < segments.length; index += 1) {
    const expected = template.segments[index];
    const actual = segments[index] ?? "";
    if (!expected) return null;
    if (expected.kind === "literal") {
      if (expected.value !== actual) return null;
    } else {
      if (actual === "") return null;
      params[expected.name] = actual;
    }
  }
  return params;
}

/**
 * Finds the best matching candidate for `segments`: the one with the most
 * literal segments, so `/network/challenges` never loses to a parameter.
 */
export function matchPath<T extends { compiled: CompiledTemplate }>(
  candidates: readonly T[],
  segments: readonly string[],
): { target: T; params: Record<string, string> } | null {
  let best: { target: T; params: Record<string, string>; literals: number } | null = null;
  for (const candidate of candidates) {
    const params = matchTemplate(candidate.compiled, segments);
    if (!params) continue;
    const literals = candidate.compiled.segments.filter((segment) => segment.kind === "literal").length;
    if (!best || literals > best.literals) best = { target: candidate, params, literals };
  }
  return best ? { target: best.target, params: best.params } : null;
}

/**
 * Validates one path parameter value. Empty values and dot segments would
 * change which resource the URL names, so they are refused (exit 2).
 */
export function checkPathParam(name: string, value: string): string {
  if (value === "") {
    throw new CliError("USAGE_ERROR", `<${name}> must not be empty.`, { humanDecision: false });
  }
  if (value === "." || value === "..") {
    throw new CliError("INVALID_PATH", `<${name}> cannot be "${value}".`, { humanDecision: false });
  }
  return value;
}

/**
 * Expands a relative template (`/agents/{id}/posts`) with URL-encoded
 * parameters. Every `{name}` must be present in `params`.
 */
export function expandTemplate(relativeTemplate: string, params: Readonly<Record<string, string>>): string {
  return relativeTemplate.replace(/\{([^{}]+)\}/g, (_whole, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new CliError("MISSING_ARGUMENT", `Missing path parameter <${name}>.`, { humanDecision: false });
    }
    return encodeURIComponent(checkPathParam(name, value));
  });
}

/** True when the decoded segments address the visitor surface (`/visitors/...`). */
export function isVisitorPath(segments: readonly string[]): boolean {
  return segments[0] === "visitors";
}

/**
 * Parses repeated `--query k=v` values. The first `=` separates the name from
 * the value; a missing `=` or an empty name is `INVALID_FLAG_VALUE` (exit 2).
 */
export function parseQueryAssignments(values: readonly string[]): Array<[string, string]> {
  return values.map((raw) => {
    const at = raw.indexOf("=");
    const name = at > 0 ? raw.slice(0, at).trim() : "";
    if (at <= 0 || name === "") {
      throw new CliError("INVALID_FLAG_VALUE", `--query expects name=value; got "${raw}".`, {
        hint: "Example: --query perPage=10 --query specialty=urbanism",
        humanDecision: false,
      });
    }
    return [name, raw.slice(at + 1)];
  });
}

/** Quotes one shell word for a suggested command (`next`), only when needed. */
export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, "'\\''")}'`;
}
