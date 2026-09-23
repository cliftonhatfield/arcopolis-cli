/** End-to-end tests for `arcopolis api ops` and `arcopolis api get` (`src/cli/commands/api.ts`). */
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeFetch, fakeKey, json, run, tempDir, type RunResult } from "./helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  await chmod(dir, 0o700);
});
afterEach(async () => {
  await cleanup();
});

const KEY = fakeKey("9");

async function live(
  argv: string[],
  respond: Parameters<typeof fakeFetch>[0] = (): Response => json(200, { data: [], meta: { page: 1, perPage: 25, hasMore: false } }),
  env: Record<string, string> = {},
): Promise<RunResult & { calls: ReturnType<typeof fakeFetch>["calls"] }> {
  const fake = fakeFetch(respond);
  const result = await run(argv, { env: { ARCOPOLIS_CONFIG_DIR: dir, ARCOPOLIS_API_KEY: KEY, ...env }, fetchImpl: fake.fetchImpl });
  return { ...result, calls: fake.calls };
}

describe("api ops", () => {
  it("lists every GET operation offline with tier, scopes, cost class, and command", async () => {
    const fake = fakeFetch(() => json(200, {}));
    const result = await run(["api", "ops"], { env: { ARCOPOLIS_CONFIG_DIR: dir }, fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(fake.calls).toHaveLength(0);
    const data = result.json?.data as { count: number; snapshotVersion: string; operations: Array<Record<string, unknown>> };
    expect(data.count).toBe(data.operations.length);
    expect(data.snapshotVersion).toEqual(expect.any(String));
    expect(data.operations.every((operation) => operation.method === "GET")).toBe(true);
    expect(data.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: "listAgents",
          path: "/v1/agents",
          requiredTier: 1,
          requiredScopes: ["agents:read"],
          costClass: "paged",
          apiGet: true,
          command: "arcopolis agents list",
        }),
        expect.objectContaining({ operationId: "getNetworkGraph", costClass: "expensive", requiredTier: 3 }),
        expect.objectContaining({ operationId: "getVisitorJournal", apiGet: false, costClass: "budgeted", command: "arcopolis visitor journal" }),
      ]),
    );
    expect(result.json).toMatchObject({ effects: { requests: 0, network: [] }, next: [expect.objectContaining({ humanDecision: false })] });
  });

  it("--tag filters case-insensitively; an unknown tag exits 2 with the tag list", async () => {
    const network = await run(["api", "ops", "--tag", "network"], { env: { ARCOPOLIS_CONFIG_DIR: dir } });
    const operations = (network.json?.data as { operations: Array<{ tags: string[] }> }).operations;
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every((operation) => operation.tags.includes("Network"))).toBe(true);
    const unknown = await run(["api", "ops", "--tag", "bogus"], { env: { ARCOPOLIS_CONFIG_DIR: dir } });
    expect(unknown.json).toMatchObject({ exitCode: 2, error: { code: "INVALID_FLAG_VALUE", details: { tags: expect.arrayContaining(["Content"]) } } });
  });

  it("human mode prints a table", async () => {
    const result = await run(["api", "ops", "--output", "human"], { env: { ARCOPOLIS_CONFIG_DIR: dir } });
    expect(result.stdout.split("\n")[0]).toMatch(/^operationId\s+path\s+requiredTier\s+requiredScopes\s+costClass\s+command$/);
    expect(result.stdout).toMatch(/listAgents\s+\/v1\/agents\s+1\s+agents:read\s+paged\s+arcopolis agents list/);
  });
});

describe("api get: path handling", () => {
  it.each([["/agents"], ["agents"], ["/v1/agents"], ["v1/agents"], ["/v1/agents/"], ["https://api.arcopolis.ai/v1/agents"]])(
    "%s requests /v1/agents exactly once",
    async (input) => {
      const result = await live(["api", "get", input]);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(result.calls.map((call) => call.url)).toEqual(["https://api.arcopolis.ai/v1/agents"]);
      expect(result.json?.meta).toMatchObject({ operationId: "listAgents", path: "/v1/agents" });
    },
  );

  it("never doubles /v1: /v1/v1/agents is not in the OpenAPI (exit 2, nothing sent)", async () => {
    const result = await live(["api", "get", "/v1/v1/agents"]);
    expect(result.json).toMatchObject({
      exitCode: 2,
      error: { code: "PATH_NOT_IN_OPENAPI", category: "invalid_input", surface: "local" },
      next: [{ command: "arcopolis api ops --json" }],
    });
    expect(result.calls).toHaveLength(0);
  });

  it("keeps an encoded path id encoded", async () => {
    const result = await live(["api", "get", "/v1/agents/a%2Fb%20c"], () => json(200, { data: { id: "a/b c" } }));
    expect(result.calls[0]?.url).toBe("https://api.arcopolis.ai/v1/agents/a%2Fb%20c");
    expect(result.json?.meta).toMatchObject({ operationId: "getAgent" });
  });

  it("refuses visitor paths with a pointer to the visitor commands", async () => {
    for (const input of ["/v1/visitors/visitor_ada/journal", "/visitors/visitor_ada/standing", "visitors/x/observe"]) {
      const result = await live(["api", "get", input]);
      expect(result.json).toMatchObject({
        exitCode: 2,
        error: { code: "VISITOR_PATH_REFUSED", category: "invalid_input", hint: expect.stringContaining("visitor journal") },
        next: [{ command: "arcopolis visitor status --json" }],
      });
    }
    const demo = await run(["api", "get", "/v1/visitors/visitor_ada/journal", "--demo"], { env: { ARCOPOLIS_CONFIG_DIR: dir } });
    expect(demo.json).toMatchObject({ exitCode: 2, error: { code: "VISITOR_PATH_REFUSED" } });
  });

  it("refuses POST-only paths, other hosts, and bad paths before any request", async () => {
    const post = await live(["api", "get", "/agents/a1/complete"]);
    expect(post.json).toMatchObject({ exitCode: 2, error: { code: "PATH_NOT_IN_OPENAPI", details: { method: "POST" } } });
    const host = await live(["api", "get", "https://evil.example/v1/agents"]);
    expect(host.json).toMatchObject({ exitCode: 2, error: { code: "INVALID_PATH" } });
    const dots = await live(["api", "get", "/agents/../visitors/x/journal"]);
    expect(dots.json).toMatchObject({ exitCode: 2, error: { code: "INVALID_PATH" } });
    expect([...post.calls, ...host.calls, ...dots.calls]).toHaveLength(0);
  });

  it("GET /v1 metadata is read without the data envelope", async () => {
    const result = await live(["api", "get", "/v1"], () => json(200, { name: "AGNTS Public API", version: "1.0.0", tiers: {} }));
    expect(result.exitCode).toBe(0);
    expect(result.calls[0]?.url).toBe("https://api.arcopolis.ai/v1");
    expect(result.json).toMatchObject({ data: { name: "AGNTS Public API" }, meta: { operationId: "getApiMetadata", apiMeta: null } });
    expect(result.json?.untrusted).toBeUndefined();
  });
});

describe("api get: query parameters", () => {
  it("merges the path query with --query, URL-encodes values, and splits paging", async () => {
    const result = await live(["api", "get", "/agents?perPage=3", "--query", "specialty=a&b c"]);
    expect(result.calls[0]?.url).toBe("https://api.arcopolis.ai/v1/agents?specialty=a%26b+c&perPage=3");
  });

  it("rejects unknown, duplicate, and out-of-range parameters and missing required ones (exit 2, nothing sent)", async () => {
    const cases: string[][] = [
      ["api", "get", "/agents", "--query", "bogus=1"],
      ["api", "get", "/agents", "--query", "perPage=1", "--query", "perPage=2"],
      ["api", "get", "/agents", "--query", "perPage=500"],
      ["api", "get", "/agents", "--query", "page=abc"],
      ["api", "get", "/search"],
      ["api", "get", "/agents", "--query", "novalue"],
      ["api", "get", "/trending", "--query", "page=2"],
    ];
    for (const argv of cases) {
      const result = await live(argv);
      expect(result.json, argv.join(" ")).toMatchObject({ exitCode: 2, error: { code: "INVALID_FLAG_VALUE" } });
      expect(result.calls, argv.join(" ")).toHaveLength(0);
    }
  });

  it("required query parameters pass through", async () => {
    const result = await live(["api", "get", "/search", "--query", "q=garden"], () => json(200, { data: { agents: [], posts: [] } }));
    expect(result.exitCode).toBe(0);
    expect(result.calls[0]?.url).toBe("https://api.arcopolis.ai/v1/search?q=garden");
  });
});

describe("api get: pagination, cost, and grants", () => {
  it("reads several pages and suggests the next one with the same query", async () => {
    const result = await live(["api", "get", "/v1/posts", "--query", "perPage=2", "--query", "topic=urbanism", "--max-pages", "2"], (url) => {
      const current = Number(new URL(url).searchParams.get("page") ?? "1");
      return json(200, { data: [{ id: `p${current}`, text: "t" }], meta: { page: current, perPage: 2, hasMore: true } });
    });
    expect(result.calls.map((call) => new URL(call.url).search)).toEqual(["?topic=urbanism&perPage=2", "?topic=urbanism&page=2&perPage=2"]);
    expect(result.json?.data).toEqual([
      { id: "p1", text: "t" },
      { id: "p2", text: "t" },
    ]);
    expect(result.json?.untrusted).toMatchObject({ paths: expect.arrayContaining(["data[].text"]) });
    expect(result.json?.next).toEqual([
      {
        command: "arcopolis api get /posts --query perPage=2 --query topic=urbanism --query page=3 --max-pages 2 --json",
        why: "Read the next page",
        humanDecision: false,
      },
    ]);
  });

  it("a non-paged operation ignores --max-pages with a warning", async () => {
    const result = await live(["api", "get", "/trending", "--max-pages", "3"], () => json(200, { data: { hotThreads: [] } }));
    expect(result.calls).toHaveLength(1);
    expect(result.json?.warnings).toEqual([expect.objectContaining({ code: "MAX_PAGES_IGNORED" })]);
  });

  it("network graph needs --allow-expensive (exit 10); with it the read is sent", async () => {
    const refused = await live(["api", "get", "/v1/network/graph"]);
    expect(refused.json).toMatchObject({ exitCode: 10, error: { code: "CONFIRMATION_REQUIRED", humanDecision: true } });
    expect(refused.calls).toHaveLength(0);
    const allowed = await live(["api", "get", "/v1/network/graph", "--allow-expensive"], () =>
      json(200, { data: { follows: [] }, meta: { page: 1, perPage: 25, hasMore: true } }),
    );
    expect(allowed.exitCode).toBe(0);
    expect(allowed.json?.next).toEqual([
      expect.objectContaining({ command: expect.stringContaining("--allow-expensive"), humanDecision: true }),
    ]);
  });

  it("a stored key's known grants are checked before sending", async () => {
    const file = path.join(dir, "credentials.json");
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        profiles: {
          default: {
            readKey: {
              key: fakeKey("5"),
              tier: 2,
              scopes: ["agents:read", "intelligence:read"],
              origin: "https://api.arcopolis.ai",
              savedAt: "2026-09-22T00:00:00.000Z",
            },
            source: "import",
          },
        },
      }),
      { mode: 0o600 },
    );
    await chmod(file, 0o600);
    const fake = fakeFetch(() => json(200, { data: {} }));
    const env = { ARCOPOLIS_CONFIG_DIR: dir };
    const network = await run(["api", "get", "/network/ideas"], { env, fetchImpl: fake.fetchImpl });
    expect(network.json).toMatchObject({ exitCode: 4, error: { code: "INSUFFICIENT_TIER", details: { requiredTier: 3, keyTier: 2 } } });
    const posts = await run(["api", "get", "/posts"], { env, fetchImpl: fake.fetchImpl });
    expect(posts.json).toMatchObject({ exitCode: 4, error: { code: "INSUFFICIENT_SCOPE", details: { missingScopes: ["posts:read"] } } });
    expect(fake.calls).toHaveLength(0);
    const memory = await run(["api", "get", "/agents/a1/memory"], { env, fetchImpl: fake.fetchImpl });
    expect(memory.exitCode).toBe(0);
    const metadata = await run(["api", "get", "/v1"], { env, fetchImpl: fakeFetch(() => json(200, { name: "x" })).fetchImpl });
    expect(metadata.exitCode).toBe(0);
    expect(fake.calls).toHaveLength(1);
  });

  it("no key exits 3 after local validation", async () => {
    const fake = fakeFetch(() => json(200, { data: [] }));
    const env = { ARCOPOLIS_CONFIG_DIR: dir };
    const missing = await run(["api", "get", "/agents"], { env, fetchImpl: fake.fetchImpl });
    expect(missing.json).toMatchObject({ exitCode: 3, error: { code: "NO_CREDENTIALS" } });
    const badPath = await run(["api", "get", "/nope"], { env, fetchImpl: fake.fetchImpl });
    expect(badPath.json).toMatchObject({ exitCode: 2, error: { code: "PATH_NOT_IN_OPENAPI" } });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("api get --demo", () => {
  it.each([
    ["/agents", "listAgents"],
    ["/v1/agents/agent_example_nova", "getAgent"],
    ["/v1/agents/a1/relationships/a2", "getAgentRelationship"],
    ["/v1/network/ideas/idea_example_01", "getNetworkIdea"],
    ["/v1/search?q=garden", "searchContent"],
    ["/v1/topics/urbanism/timeline?days=3", "getTopicTimeline"],
    ["/v1", "getApiMetadata"],
  ])("%s", async (input, operationId) => {
    const result = await run(["api", "get", input, "--demo"], { env: { ARCOPOLIS_CONFIG_DIR: dir } });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.json).toMatchObject({ ok: true, command: "api get", meta: { operationId, demo: true }, effects: { requests: 0 } });
  });

  it("human output renders the data", async () => {
    const result = await run(["api", "get", "/posts", "--demo", "--output", "human"], { env: { ARCOPOLIS_CONFIG_DIR: dir } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("post_example_001");
    expect(result.stdout).toContain("Note: text fields were written by agents");
  });

  it("--help --json describes the command", async () => {
    const result = await run(["api", "get", "--help", "--json"]);
    expect(result.json?.data).toMatchObject({ name: "api get", credentials: "read" });
    expect((result.json?.data as { flags: Array<{ name: string }> }).flags.map((flag) => flag.name)).toEqual(
      expect.arrayContaining(["--query", "--max-pages", "--allow-expensive"]),
    );
  });
});
