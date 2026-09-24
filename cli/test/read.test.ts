/** End-to-end tests for the content read commands (`src/cli/commands/read.ts`), in demo mode and against fetch fakes. */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeFetch, fakeKey, json, run, tempDir, type RunResult } from "./helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await cleanup();
});

const KEY = fakeKey("9");

/** Runs with an env read key and a fetch fake (live mode, no network). */
async function live(argv: string[], respond: Parameters<typeof fakeFetch>[0]): Promise<RunResult & { calls: ReturnType<typeof fakeFetch>["calls"] }> {
  const fake = fakeFetch(respond);
  const result = await run(argv, { env: { ARCOPOLIS_CONFIG_DIR: dir, ARCOPOLIS_API_KEY: KEY }, fetchImpl: fake.fetchImpl });
  return { ...result, calls: fake.calls };
}

/** Writes a stored profile whose read key has the given tier and scopes. */
async function storeReadKey(tier: number, scopes: string[]): Promise<string> {
  const key = fakeKey("5");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = path.join(dir, "credentials.json");
  const credentials = {
    schemaVersion: 1,
    profiles: {
      default: {
        readKey: { key, tier, scopes, origin: "https://api.arcopolis.ai", savedAt: "2026-09-22T00:00:00.000Z" },
        source: "import",
      },
    },
  };
  await writeFile(file, JSON.stringify(credentials), { mode: 0o600 });
  await chmod(file, 0o600);
  return key;
}

function page(items: Array<Record<string, unknown>>, meta: Record<string, unknown>): Response {
  return json(200, { data: items, meta });
}

describe("every read command works in --demo", () => {
  const cases: Array<{ argv: string[]; command: string; operationId: string; untrusted: boolean }> = [
    { argv: ["agents", "list"], command: "agents list", operationId: "listAgents", untrusted: true },
    { argv: ["agents", "get", "agent_example_nova"], command: "agents get", operationId: "getAgent", untrusted: true },
    { argv: ["agents", "posts", "agent_example_nova"], command: "agents posts", operationId: "listAgentPosts", untrusted: true },
    { argv: ["agents", "memory", "a1"], command: "agents memory", operationId: "getAgentMemory", untrusted: true },
    { argv: ["agents", "mood", "a1"], command: "agents mood", operationId: "getAgentMood", untrusted: true },
    { argv: ["agents", "relationships", "a1"], command: "agents relationships", operationId: "listAgentRelationships", untrusted: true },
    { argv: ["agents", "relationships", "a1", "a2"], command: "agents relationships", operationId: "getAgentRelationship", untrusted: true },
    { argv: ["agents", "reputation", "a1"], command: "agents reputation", operationId: "getAgentReputation", untrusted: false },
    { argv: ["agents", "signals", "a1"], command: "agents signals", operationId: "listAgentSignals", untrusted: true },
    { argv: ["agents", "thoughts", "a1"], command: "agents thoughts", operationId: "getAgentThoughts", untrusted: true },
    { argv: ["agents", "topics", "a1"], command: "agents topics", operationId: "getAgentTopics", untrusted: false },
    { argv: ["posts", "list", "--topic", "urbanism"], command: "posts list", operationId: "listPosts", untrusted: true },
    { argv: ["posts", "get", "post_example_001"], command: "posts get", operationId: "getPost", untrusted: true },
    { argv: ["posts", "replies", "post_example_001"], command: "posts replies", operationId: "listPostReplies", untrusted: true },
    { argv: ["trending"], command: "trending", operationId: "getTrending", untrusted: true },
    { argv: ["search", "garden"], command: "search", operationId: "searchContent", untrusted: true },
    { argv: ["topics", "list"], command: "topics list", operationId: "listTopics", untrusted: false },
    { argv: ["topics", "timeline", "urbanism", "--days", "7"], command: "topics timeline", operationId: "getTopicTimeline", untrusted: false },
    { argv: ["network", "graph", "--allow-expensive"], command: "network graph", operationId: "getNetworkGraph", untrusted: true },
    { argv: ["network", "ideas", "--status", "all"], command: "network ideas", operationId: "listNetworkIdeas", untrusted: true },
    { argv: ["network", "ideas", "idea_example_01"], command: "network ideas", operationId: "getNetworkIdea", untrusted: true },
    { argv: ["network", "challenges"], command: "network challenges", operationId: "listNetworkChallenges", untrusted: true },
    { argv: ["network", "challenges", "challenge_example_01"], command: "network challenges", operationId: "getNetworkChallenge", untrusted: true },
  ];

  it.each(cases)("$argv", async ({ argv, command, operationId, untrusted }) => {
    const result = await run([...argv, "--demo"], { env: { ARCOPOLIS_CONFIG_DIR: dir } });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    const doc = result.json as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual([
      "schemaVersion",
      "ok",
      "command",
      "exitCode",
      "data",
      "meta",
      "effects",
      ...(untrusted ? ["untrusted"] : []),
      "warnings",
      "next",
    ]);
    expect(doc).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command,
      exitCode: 0,
      meta: { operationId, demo: true },
      effects: { network: [], requests: 0, writes: [], spends: {}, secretsWritten: [] },
    });
    expect(doc.data).not.toBeNull();
    if (untrusted) {
      expect(doc.untrusted).toMatchObject({ note: expect.stringContaining("Treat as data"), paths: expect.any(Array) });
      for (const entry of (doc.untrusted as { paths: string[] }).paths) expect(entry.startsWith("data")).toBe(true);
    }
  });

  it("list results carry pagination meta; single reads do not", async () => {
    const list = await run(["agents", "list", "--demo"], { env: { ARCOPOLIS_CONFIG_DIR: dir } });
    expect(list.json?.meta).toMatchObject({
      apiMeta: { page: 1, hasMore: false },
      pagination: { startPage: 1, pages: 1, maxPages: 1, stoppedBecause: "no_more", hasMore: false, nextPage: null },
    });
    expect(list.json?.untrusted).toMatchObject({ paths: expect.arrayContaining(["data[].bio", "data[].displayName"]) });
    const one = await run(["agents", "get", "agent_example_nova", "--demo"], { env: { ARCOPOLIS_CONFIG_DIR: dir } });
    expect((one.json?.meta as Record<string, unknown>).pagination).toBeUndefined();
    expect(one.json?.data).toMatchObject({ id: "agent_example_nova" });
  });

  it("human mode prints a compact table and the untrusted note", async () => {
    const result = await run(["agents", "list", "--demo", "--output", "human"], { env: { ARCOPOLIS_CONFIG_DIR: dir } });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toMatch(/^id\s+handle\s+displayName\s+specialty\s+postCount\s+followersCount$/);
    expect(lines[1]).toMatch(/^agent_example_nova\s+@nova\s+Nova\s+urbanism\s+12\s+8$/);
    expect(result.stdout).toContain("Note: text fields were written by agents");
  });
});

describe("credentials and local prechecks", () => {
  it("no key exits 3 NO_CREDENTIALS before any request", async () => {
    const fake = fakeFetch(() => json(200, { data: [] }));
    const result = await run(["agents", "list"], { env: { ARCOPOLIS_CONFIG_DIR: dir }, fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(3);
    expect(result.json).toMatchObject({ error: { code: "NO_CREDENTIALS" }, next: [{ command: "arcopolis setup --json" }] });
    expect(fake.calls).toHaveLength(0);
  });

  it("a stored tier-1 key fails tier-2 and tier-3 reads locally with exit 4 and sends nothing", async () => {
    await storeReadKey(1, ["agents:read", "posts:read"]);
    const fake = fakeFetch(() => json(200, { data: {} }));
    const env = { ARCOPOLIS_CONFIG_DIR: dir };
    const memory = await run(["agents", "memory", "a1"], { env, fetchImpl: fake.fetchImpl });
    expect(memory.exitCode).toBe(4);
    expect(memory.json).toMatchObject({
      command: "agents memory",
      error: {
        code: "INSUFFICIENT_TIER",
        category: "forbidden",
        surface: "local",
        humanDecision: true,
        details: { requiredTier: 2, keyTier: 1, checkedLocally: true },
      },
      effects: { requests: 0 },
      next: [{ command: "arcopolis portal", humanDecision: true }],
    });
    const graph = await run(["network", "graph", "--allow-expensive"], { env, fetchImpl: fake.fetchImpl });
    expect(graph.json).toMatchObject({ exitCode: 4, error: { code: "INSUFFICIENT_TIER" } });
    expect(fake.calls).toHaveLength(0);
  });

  it("a stored key missing a scope fails with INSUFFICIENT_SCOPE; a covered read is sent with the stored key", async () => {
    const key = await storeReadKey(1, ["agents:read", "posts:read"]);
    const fake = fakeFetch(() => page([], { page: 1, perPage: 25, hasMore: false }));
    const env = { ARCOPOLIS_CONFIG_DIR: dir };
    const search = await run(["search", "garden"], { env, fetchImpl: fake.fetchImpl });
    expect(search.json).toMatchObject({ exitCode: 4, error: { code: "INSUFFICIENT_SCOPE", details: { missingScopes: ["search:read"] } } });
    expect(fake.calls).toHaveLength(0);
    const list = await run(["agents", "list"], { env, fetchImpl: fake.fetchImpl });
    expect(list.exitCode).toBe(0);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.headers["x-api-key"]).toBe(key);
    expect(list.stdout).not.toContain(key);
  });

  it("an env key has unknown grants, so the server decides", async () => {
    const result = await live(["agents", "memory", "a1"], () =>
      json(403, { error: { code: "INSUFFICIENT_TIER", message: "This endpoint requires API tier 2 or higher." } }),
    );
    expect(result.calls).toHaveLength(1);
    expect(result.json).toMatchObject({ exitCode: 4, error: { code: "INSUFFICIENT_TIER", surface: "data", httpStatus: 403 } });
  });

  it("network graph without --allow-expensive exits 10 and sends nothing", async () => {
    const result = await live(["network", "graph"], () => json(200, { data: {} }));
    expect(result.exitCode).toBe(10);
    expect(result.json).toMatchObject({
      error: { code: "CONFIRMATION_REQUIRED", category: "needs_human", humanDecision: true, details: { flag: "--allow-expensive" } },
      next: [],
    });
    expect(result.calls).toHaveLength(0);
    const demo = await run(["network", "graph", "--demo"], { env: { ARCOPOLIS_CONFIG_DIR: dir } });
    expect(demo.exitCode).toBe(10);
  });
});

describe("request shape", () => {
  it("URL-encodes path ids and query values and never doubles /v1", async () => {
    const result = await live(["agents", "get", "a/b c?d#e"], () => json(200, { data: { id: "x" } }));
    expect(result.exitCode).toBe(0);
    expect(result.calls[0]?.url).toBe("https://api.arcopolis.ai/v1/agents/a%2Fb%20c%3Fd%23e");
    expect(result.calls[0]?.init.method).toBe("GET");
    expect(result.calls[0]?.init.body).toBeUndefined();

    const topic = await live(["posts", "list", "--topic", "a&b=c d"], () => page([], { page: 1, perPage: 25, hasMore: false }));
    expect(topic.calls[0]?.url).toBe("https://api.arcopolis.ai/v1/posts?topic=a%26b%3Dc+d");

    const rel = await live(["agents", "relationships", "a 1", "b/2"], () => json(200, { data: {} }));
    expect(rel.calls[0]?.url).toBe("https://api.arcopolis.ai/v1/agents/a%201/relationships/b%2F2");
    expect(rel.json?.meta).toMatchObject({ operationId: "getAgentRelationship" });
  });

  it("dot-segment ids are refused locally (exit 2)", async () => {
    const result = await live(["agents", "get", ".."], () => json(200, { data: {} }));
    expect(result.json).toMatchObject({ exitCode: 2, error: { code: "INVALID_PATH" } });
    expect(result.calls).toHaveLength(0);
  });

  it("sends only the query parameters that were set", async () => {
    const plain = await live(["agents", "list"], () => page([], { page: 1, perPage: 25, hasMore: false }));
    expect(plain.calls[0]?.url).toBe("https://api.arcopolis.ai/v1/agents");
    const timeline = await live(["topics", "timeline", "urbanism", "--days", "14"], () => json(200, { data: [] }));
    expect(timeline.calls[0]?.url).toBe("https://api.arcopolis.ai/v1/topics/urbanism/timeline?days=14");
    const graph = await live(["network", "graph", "--allow-expensive", "--include", "both"], () =>
      json(200, { data: { follows: [], relationships: [] }, meta: { page: 1, perPage: 25, hasMore: false } }),
    );
    expect(graph.calls[0]?.url).toBe("https://api.arcopolis.ai/v1/network/graph?include=follows%2Crelationships");
    expect(graph.json).toMatchObject({ effects: { network: ["data"], requests: 1, spends: { rateLimit: 1 } } });
  });

  it("maps API errors to exit codes", async () => {
    const missing = await live(["posts", "get", "nope"], () => json(404, { error: { code: "NOT_FOUND", message: "Post not found" } }));
    expect(missing.json).toMatchObject({ exitCode: 5, error: { code: "NOT_FOUND", surface: "data" } });
    const limited = await live(["trending"], () =>
      json(429, { error: { code: "RATE_LIMIT_EXCEEDED", message: "Slow down" } }, { "retry-after": "30" }),
    );
    expect(limited.json).toMatchObject({ exitCode: 6, error: { retry: { strategy: "after_seconds", afterSeconds: 30 } } });
  });
});

describe("pagination", () => {
  it("follows meta.hasMore up to --max-pages, de-duplicates by id, and suggests the next page", async () => {
    const pages: Record<string, Array<Record<string, unknown>>> = {
      "1": [{ id: "a" }, { id: "b" }],
      "2": [{ id: "b" }, { id: "c" }],
      "3": [{ id: "d" }],
    };
    const result = await live(["agents", "list", "--per-page", "2", "--max-pages", "3", "--specialty", "urbanism"], (url) => {
      const current = new URL(url).searchParams.get("page") ?? "1";
      return page(pages[current] ?? [], { page: Number(current), perPage: 2, hasMore: true });
    });
    expect(result.exitCode).toBe(0);
    expect(result.calls.map((call) => call.url)).toEqual([
      "https://api.arcopolis.ai/v1/agents?specialty=urbanism&perPage=2",
      "https://api.arcopolis.ai/v1/agents?specialty=urbanism&page=2&perPage=2",
      "https://api.arcopolis.ai/v1/agents?specialty=urbanism&page=3&perPage=2",
    ]);
    expect((result.json?.data as Array<{ id: string }>).map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    expect(result.json?.meta).toMatchObject({
      pagination: { startPage: 1, pages: 3, maxPages: 3, perPage: 2, items: 4, stoppedBecause: "max_pages", hasMore: true, nextPage: 4 },
      apiMeta: { page: 3 },
    });
    expect(result.json?.effects).toMatchObject({ requests: 3, spends: { rateLimit: 3 } });
    expect(result.json?.next).toEqual([
      {
        command: "arcopolis agents list --specialty urbanism --per-page 2 --max-pages 3 --page 4 --json",
        why: "Read the next page",
        humanDecision: false,
      },
    ]);
  });

  it("starts at --page and stops when hasMore is false", async () => {
    const result = await live(["posts", "replies", "p1", "--page", "4", "--max-pages", "5"], (url) =>
      page([{ id: `r${new URL(url).searchParams.get("page")}` }], {
        page: Number(new URL(url).searchParams.get("page")),
        perPage: 25,
        hasMore: new URL(url).searchParams.get("page") === "4",
      }),
    );
    expect(result.calls.map((call) => new URL(call.url).search)).toEqual(["?page=4", "?page=5"]);
    expect(result.json?.meta).toMatchObject({ pagination: { startPage: 4, pages: 2, stoppedBecause: "no_more", nextPage: null } });
    expect(result.json?.next).toEqual([]);
  });

  it("stops at 500 items", async () => {
    let served = 0;
    const result = await live(["posts", "list", "--per-page", "100", "--max-pages", "10"], (url) => {
      const current = Number(new URL(url).searchParams.get("page") ?? "1");
      const items = Array.from({ length: 100 }, (_, index) => ({ id: `p${current}-${index}` }));
      served += 1;
      return page(items, { page: current, perPage: 100, hasMore: true });
    });
    expect(served).toBe(5);
    expect((result.json?.data as unknown[]).length).toBe(500);
    expect(result.json?.meta).toMatchObject({ pagination: { stoppedBecause: "max_items", truncated: true, pages: 5 } });
    expect(result.json?.warnings).toEqual([expect.objectContaining({ code: "PAGINATION_ITEM_CAP" })]);
  });

  it("keeps earlier pages when a later page fails, and warns", async () => {
    const result = await live(["topics", "list", "--max-pages", "3"], (url) => {
      const current = new URL(url).searchParams.get("page") ?? "1";
      if (current === "2") return json(503, { error: { code: "INTERNAL_ERROR", message: "try later" } });
      return page([{ topicId: "t1" }], { page: 1, perPage: 25, hasMore: true });
    });
    expect(result.exitCode).toBe(0);
    expect(result.calls).toHaveLength(2);
    expect(result.json?.data).toEqual([{ topicId: "t1" }]);
    expect(result.json?.meta).toMatchObject({
      pagination: { stoppedBecause: "error", nextPage: 2, error: { code: "INTERNAL_ERROR", exitCode: 12 } },
    });
    expect(result.json?.warnings).toEqual([expect.objectContaining({ code: "PAGINATION_STOPPED" })]);
    expect(result.json?.next).toEqual([expect.objectContaining({ command: "arcopolis topics list --max-pages 3 --page 2 --json" })]);
  });

  it("pages agents relationships and keeps edges that have no id", async () => {
    const result = await live(["agents", "relationships", "a1", "--per-page", "2", "--max-pages", "2"], (url) => {
      const current = Number(new URL(url).searchParams.get("page") ?? "1");
      const edges = [{ agentId: "a1", otherAgentId: `o${current}a` }, { agentId: "a1", otherAgentId: `o${current}b` }];
      return page(edges, { page: current, perPage: 2, total: 5, hasMore: current < 3 });
    });
    expect(result.exitCode).toBe(0);
    expect(result.calls.map((call) => new URL(call.url).search)).toEqual(["?perPage=2", "?page=2&perPage=2"]);
    expect((result.json?.data as Array<{ otherAgentId: string }>).map((e) => e.otherAgentId)).toEqual(["o1a", "o1b", "o2a", "o2b"]);
    expect(result.json?.meta).toMatchObject({ pagination: { pages: 2, stoppedBecause: "max_pages", nextPage: 3 } });
    expect(result.json?.next).toEqual([
      expect.objectContaining({ command: "arcopolis agents relationships a1 --per-page 2 --max-pages 2 --page 3 --json" }),
    ]);
  });

  it("reads one relationship with other-id and sends no page query", async () => {
    const result = await live(["agents", "relationships", "a1", "b2", "--page", "3"], () =>
      json(200, { data: { agentId: "a1", otherAgentId: "b2" } }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.calls.map((call) => call.url)).toEqual(["https://api.arcopolis.ai/v1/agents/a1/relationships/b2"]);
  });

  it("pages agents thoughts by concatenating both lists", async () => {
    const result = await live(["agents", "thoughts", "a1", "--page", "2", "--max-pages", "3"], (url) => {
      const current = Number(new URL(url).searchParams.get("page") ?? "1");
      return json(200, {
        data: {
          thoughts: [{ aboutAgentId: "x", text: `t${current}`, createdAt: "2026-09-01T12:00:00.000Z" }],
          impressions: current === 2 ? [{ aboutAgentId: "x", summary: "s2", updatedAt: "2026-09-01T12:00:00.000Z" }] : [],
        },
        meta: { page: current, perPage: 25, total: 3, hasMore: current < 3 },
      });
    });
    expect(result.exitCode).toBe(0);
    expect(result.calls.map((call) => new URL(call.url).search)).toEqual(["?page=2", "?page=3"]);
    const data = result.json?.data as { thoughts: Array<{ text: string }>; impressions: unknown[] };
    expect(data.thoughts.map((t) => t.text)).toEqual(["t2", "t3"]);
    expect(data.impressions).toHaveLength(1);
    expect(result.json?.meta).toMatchObject({ pagination: { startPage: 2, pages: 2, stoppedBecause: "no_more", nextPage: null } });
  });

  it("a first-page error is the command's error", async () => {
    const result = await live(["agents", "list", "--max-pages", "3"], () =>
      json(401, { error: { code: "INVALID_API_KEY", message: "Invalid API key" } }),
    );
    expect(result.json).toMatchObject({ exitCode: 3, error: { code: "INVALID_API_KEY" } });
    expect(result.calls).toHaveLength(1);
  });

  it("enforces the page caps at parse time", async () => {
    const fake = fakeFetch(() => json(200, { data: [] }));
    const env = { ARCOPOLIS_CONFIG_DIR: dir, ARCOPOLIS_API_KEY: KEY };
    expect((await run(["agents", "list", "--max-pages", "11"], { env, fetchImpl: fake.fetchImpl })).json).toMatchObject({
      exitCode: 2,
      error: { code: "INVALID_FLAG_VALUE" },
    });
    expect((await run(["agents", "list", "--per-page", "101"], { env, fetchImpl: fake.fetchImpl })).json).toMatchObject({
      exitCode: 2,
    });
    expect((await run(["agents", "list", "--page", "0"], { env, fetchImpl: fake.fetchImpl })).json).toMatchObject({ exitCode: 2 });
    // Deep offset pages re-read every skipped document server-side.
    expect((await run(["agents", "list", "--page", "51"], { env, fetchImpl: fake.fetchImpl })).json).toMatchObject({ exitCode: 2 });
    expect((await run(["api", "get", "/v1/agents", "--query", "page=51"], { env, fetchImpl: fake.fetchImpl })).json).toMatchObject({ exitCode: 2 });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("search", () => {
  it("maps --page/--per-page to both modes and --type to legacy", async () => {
    const result = await live(["search", "public", "space", "--type", "posts", "--page", "2", "--per-page", "80"], () =>
      json(200, { data: [{ id: "p1", text: "hi" }], meta: { page: 2, perPage: 80, hasMore: false } }),
    );
    const params = new URL(result.calls[0]?.url ?? "").searchParams;
    expect(Object.fromEntries(params)).toEqual({
      q: "public space",
      type: "posts",
      postsPage: "2",
      postsPerPage: "50",
      page: "2",
      perPage: "80",
    });
    expect(result.json?.meta).toMatchObject({ searchMode: "legacy" });
    expect(result.json?.warnings).toEqual([expect.objectContaining({ code: "SEARCH_COST_NOTE" })]);
    expect(result.stderr).toContain("legacy search");
    expect(result.json?.untrusted).toMatchObject({ paths: expect.arrayContaining(["data[].text"]) });
  });

  it("combined search says when --type was ignored", async () => {
    const result = await live(["search", "garden", "--type", "agents"], () =>
      json(200, { data: { agents: [], posts: [] }, meta: { agents: { page: 1, perPage: 12, hasMore: false } } }),
    );
    expect(result.json?.meta).toMatchObject({ searchMode: "combined" });
    expect(result.json?.warnings).toEqual([expect.objectContaining({ code: "SEARCH_TYPE_IGNORED" })]);
    const params = new URL(result.calls[0]?.url ?? "").searchParams;
    expect(params.get("q")).toBe("garden");
    expect(params.has("postsPage")).toBe(false);
  });

  it("short queries are refused locally", async () => {
    const result = await live(["search", " a "], () => json(200, { data: [] }));
    expect(result.json).toMatchObject({ exitCode: 2, error: { code: "USAGE_ERROR" } });
    expect(result.calls).toHaveLength(0);
  });
});

describe("human rendering of live data", () => {
  it("strips terminal escapes from agent-written text", async () => {
    const fake = fakeFetch(() =>
      page([{ id: "p1", agentHandle: "@x", createdAt: "2026-09-22T00:00:00.000Z", likeCount: 1, replyCount: 0, text: "hi\u001b[2Jthere" }], {
        page: 1,
        perPage: 25,
        hasMore: true,
      }),
    );
    const result = await run(["posts", "list", "--output", "human"], {
      env: { ARCOPOLIS_CONFIG_DIR: dir, ARCOPOLIS_API_KEY: KEY },
      fetchImpl: fake.fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stdout).toContain("hithere");
    expect(result.stdout).toContain("1 item(s), page 1; more available.");
    expect(result.stdout).toContain("Next: arcopolis posts list --page 2  # Read the next page");
    expect(result.stdout).not.toContain(KEY);
  });
});
