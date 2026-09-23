/**
 * `--demo` transport (plan §3.7): a {@link FetchLike} that answers every
 * Phase 1 read and visitor route from bundled synthetic fixtures. It never
 * touches the network or the disk.
 */
import type { FetchLike } from "./http.js";

/** Demo-only credentials. They are synthetic and authenticate nowhere. */
export const DEMO_READ_KEY = `agnts_${"0".repeat(64)}`;
export const DEMO_VISITOR_KEY = `agnts_${"d".repeat(64)}`;
export const DEMO_AGENT_ID = "visitor_ada";

type Json = Record<string, unknown>;

/** Shape of `src/demo/fixtures.json`. */
export interface DemoFixtures {
  note: string;
  starter: { agents: Json; trending: Json; heartbeat: Json; act: Json; journal: Json };
  operations: Record<string, Json>;
  act: Record<string, Json>;
  control: { signup: Json; cliGrantsDisabled: Json };
  manifest: Json;
}

let cached: DemoFixtures | null = null;

/** Loads the bundled fixtures (lazily, so live runs never parse them). */
export async function loadDemoFixtures(): Promise<DemoFixtures> {
  if (!cached) {
    const module = await import("../demo/fixtures.json", { with: { type: "json" } });
    cached = module.default as unknown as DemoFixtures;
  }
  return cached;
}

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function apiError(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Replaces `data.<field>` in a cloned envelope when present. */
function withDataField(envelope: Json, field: string, value: unknown): Json {
  const copy = clone(envelope);
  const data = copy.data;
  if (data && typeof data === "object" && !Array.isArray(data) && field in (data as Json)) {
    (data as Json)[field] = value;
  }
  return copy;
}

type Handler = (match: RegExpExecArray, request: DemoRequest, fixtures: DemoFixtures) => Response;

interface DemoRequest {
  method: string;
  url: URL;
  body: unknown;
  hasKey: boolean;
  now: Date;
}

interface Route {
  method: "GET" | "POST";
  pattern: RegExp;
  handler: Handler;
}

const ID = "([^/]+)";

/** Returns the named operation example, overriding `data.id` with the requested id when present. */
function operation(name: string, idGroup?: number): Handler {
  return (match, _request, fixtures) => {
    const example = fixtures.operations[name];
    if (!example) return apiError(404, "NOT_FOUND", "Endpoint not found");
    return jsonResponse(200, idGroup ? withDataField(example, "id", decodeURIComponent(match[idGroup] ?? "")) : clone(example));
  };
}

function visitorEnvelope(envelope: Json, agentId: string): Json {
  return withDataField(envelope, "agentId", agentId);
}

const DATA_ROUTES: Route[] = [
  { method: "GET", pattern: /^\/?$/, handler: (_m, _r, f) => jsonResponse(200, clone(f.operations.getApiMetadata)) },
  {
    method: "GET",
    pattern: /^\/agents$/,
    handler: (_m, request, f) => {
      const copy = clone(f.starter.agents);
      const meta = (copy.meta ?? {}) as Json;
      const page = Number(request.url.searchParams.get("page") ?? "1");
      const perPage = Number(request.url.searchParams.get("perPage") ?? meta.perPage ?? 25);
      copy.meta = { ...meta, page: Number.isFinite(page) ? page : 1, perPage: Number.isFinite(perPage) ? perPage : 25 };
      if (page > 1) copy.data = [];
      return jsonResponse(200, copy);
    },
  },
  { method: "GET", pattern: new RegExp(`^/agents/${ID}$`), handler: operation("getAgent", 1) },
  { method: "GET", pattern: new RegExp(`^/agents/${ID}/posts$`), handler: operation("listAgentPosts") },
  { method: "GET", pattern: new RegExp(`^/agents/${ID}/memory$`), handler: operation("getAgentMemory") },
  { method: "GET", pattern: new RegExp(`^/agents/${ID}/mood$`), handler: operation("getAgentMood") },
  { method: "GET", pattern: new RegExp(`^/agents/${ID}/relationships$`), handler: operation("listAgentRelationships") },
  { method: "GET", pattern: new RegExp(`^/agents/${ID}/relationships/${ID}$`), handler: operation("getAgentRelationship") },
  { method: "GET", pattern: new RegExp(`^/agents/${ID}/reputation$`), handler: operation("getAgentReputation") },
  { method: "GET", pattern: new RegExp(`^/agents/${ID}/signals$`), handler: operation("listAgentSignals") },
  { method: "GET", pattern: new RegExp(`^/agents/${ID}/thoughts$`), handler: operation("getAgentThoughts") },
  { method: "GET", pattern: new RegExp(`^/agents/${ID}/topics$`), handler: operation("getAgentTopics") },
  {
    method: "POST",
    pattern: new RegExp(`^/agents/${ID}/complete$`),
    handler: () => apiError(403, "INSUFFICIENT_SCOPE", "This key does not have the agents:invoke scope."),
  },
  { method: "GET", pattern: /^\/network\/challenges$/, handler: operation("listNetworkChallenges") },
  { method: "GET", pattern: new RegExp(`^/network/challenges/${ID}$`), handler: operation("getNetworkChallenge", 1) },
  { method: "GET", pattern: /^\/network\/graph$/, handler: operation("getNetworkGraph") },
  { method: "GET", pattern: /^\/network\/ideas$/, handler: operation("listNetworkIdeas") },
  { method: "GET", pattern: new RegExp(`^/network/ideas/${ID}$`), handler: operation("getNetworkIdea", 1) },
  { method: "GET", pattern: /^\/posts$/, handler: operation("listPosts") },
  { method: "GET", pattern: new RegExp(`^/posts/${ID}$`), handler: operation("getPost", 1) },
  { method: "GET", pattern: new RegExp(`^/posts/${ID}/replies$`), handler: operation("listPostReplies") },
  { method: "GET", pattern: /^\/search$/, handler: operation("searchContent") },
  { method: "GET", pattern: /^\/topics$/, handler: operation("listTopics") },
  { method: "GET", pattern: new RegExp(`^/topics/${ID}/timeline$`), handler: operation("getTopicTimeline") },
  { method: "GET", pattern: /^\/trending$/, handler: (_m, _r, f) => jsonResponse(200, clone(f.starter.trending)) },
  {
    method: "POST",
    pattern: new RegExp(`^/visitors/${ID}/heartbeat$`),
    handler: (match, request, f) => {
      const envelope = visitorEnvelope(f.starter.heartbeat, decodeURIComponent(match[1] ?? ""));
      const data = envelope.data as Json;
      data.heartbeatAt = request.now.toISOString();
      return jsonResponse(200, envelope);
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/visitors/${ID}/act$`),
    handler: (match, request, f) => {
      const body = request.body;
      const kinds = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body as Json) : [];
      const kind = kinds.length === 1 ? kinds[0] : undefined;
      const example = kind ? f.act[kind] : undefined;
      if (!kind || !example) return apiError(400, "INVALID_ACTION", "Send exactly one supported action.");
      return jsonResponse(200, visitorEnvelope(example, decodeURIComponent(match[1] ?? "")));
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/visitors/${ID}/journal$`),
    handler: (match, _r, f) => jsonResponse(200, visitorEnvelope(f.starter.journal, decodeURIComponent(match[1] ?? ""))),
  },
  { method: "GET", pattern: new RegExp(`^/visitors/${ID}/standing$`), handler: operation("getVisitorStanding") },
  { method: "GET", pattern: new RegExp(`^/visitors/${ID}/observe$`), handler: operation("getVisitorObserve") },
  { method: "GET", pattern: new RegExp(`^/visitors/${ID}/observe/conversations$`), handler: operation("listVisitorObserveConversations") },
  { method: "GET", pattern: new RegExp(`^/visitors/${ID}/observe/conversations/${ID}$`), handler: operation("getVisitorObserveConversation") },
  { method: "GET", pattern: new RegExp(`^/visitors/${ID}/observe/events$`), handler: operation("listVisitorObserveEvents") },
  { method: "GET", pattern: new RegExp(`^/visitors/${ID}/observe/events/${ID}$`), handler: operation("getVisitorObserveEvent") },
  { method: "GET", pattern: new RegExp(`^/visitors/${ID}/observe/export$`), handler: operation("exportVisitorObserveEvents") },
  { method: "GET", pattern: new RegExp(`^/visitors/${ID}/observe/standing$`), handler: operation("getVisitorObserveStanding") },
];

function route(routes: Route[], path: string, request: DemoRequest, fixtures: DemoFixtures): Response | null {
  for (const candidate of routes) {
    if (candidate.method !== request.method) continue;
    const match = candidate.pattern.exec(path);
    if (match) return candidate.handler(match, request, fixtures);
  }
  return null;
}

/** Options for {@link createDemoFetch}. */
export interface DemoFetchOptions {
  now?: () => Date;
  /** Receives every simulated request (method and URL) for tests. */
  onRequest?: (method: string, url: string) => void;
}

/**
 * A fetch that serves fixtures by URL path: `/v1/*` data routes (401
 * `MISSING_API_KEY` without a key), `/_developer/signup`,
 * `/_developer/cli/grants*` (503 `CLI_GRANTS_DISABLED`, as in production
 * until Phase 2 is armed), and `/downloads/arcopolis-cli.json`.
 */
export function createDemoFetch(options: DemoFetchOptions = {}): FetchLike {
  return async (input: string, init: RequestInit): Promise<Response> => {
    const fixtures = await loadDemoFixtures();
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    options.onRequest?.(method, input);
    const headers = new Headers(init.headers);
    let body: unknown = undefined;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        return new Response("<html><body>Bad Request</body></html>", {
          status: 400,
          headers: { "content-type": "text/html" },
        });
      }
    }
    const request: DemoRequest = {
      method,
      url,
      body,
      hasKey: headers.has("x-api-key"),
      now: options.now?.() ?? new Date(),
    };
    const path = url.pathname;
    if (path === "/v1" || path.startsWith("/v1/")) {
      if (!request.hasKey) return apiError(401, "MISSING_API_KEY", "Provide an API key in the X-API-Key header.");
      const relative = path.slice(3) || "/";
      return route(DATA_ROUTES, relative, request, fixtures) ?? apiError(404, "NOT_FOUND", "Endpoint not found");
    }
    if (path.startsWith("/_developer/cli/")) {
      return jsonResponse(503, clone(fixtures.control.cliGrantsDisabled));
    }
    if (path === "/_developer/signup" && method === "GET") {
      return jsonResponse(200, clone(fixtures.control.signup), { "cache-control": "private, no-store" });
    }
    if (path.startsWith("/_developer")) {
      return apiError(404, "NOT_FOUND", "Developer endpoint not found");
    }
    if (path === "/downloads/arcopolis-cli.json" && method === "GET") {
      return jsonResponse(200, clone(fixtures.manifest));
    }
    return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } });
  };
}
