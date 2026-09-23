/** Unit tests for the OpenAPI catalog (`src/openapi/ops.ts`) and path handling (`src/openapi/match.ts`). */
import { describe, expect, it } from "vitest";
import { commands as readCommands } from "../src/cli/commands/read.js";
import { DEFAULT_API_BASE, checkBase } from "../src/core/bases.js";
import { CliError } from "../src/core/errors.js";
import { HttpClient } from "../src/core/http.js";
import {
  checkPathParam,
  compileTemplate,
  expandTemplate,
  isVisitorPath,
  matchPath,
  normalizeApiPath,
  parseQueryAssignments,
  shellQuote,
  stripOneV1,
} from "../src/openapi/match.js";
import {
  OPERATION_COMMANDS,
  assertExpensiveAllowed,
  assertKeyAllowed,
  buildOperations,
  cellText,
  describeOperation,
  executeRead,
  getOperation,
  listOperations,
  loadOperations,
  renderTable,
  resolveApiGet,
  resolveOperationRequest,
  sanitizeText,
  untrustedPathsForSchema,
  type OpenApiDocument,
} from "../src/openapi/ops.js";
import { fakeFetch, fakeKey, json } from "./helpers.js";

function expectCliError(fn: () => unknown, code: string, exitCode?: number): CliError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    const cliError = error as CliError;
    expect(cliError.code).toBe(code);
    if (exitCode !== undefined) expect(cliError.exitCode).toBe(exitCode);
    return cliError;
  }
  throw new Error(`expected ${code}`);
}

async function expectCliRejection(promise: Promise<unknown>, code: string, exitCode?: number): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    const cliError = error as CliError;
    expect(cliError.code).toBe(code);
    if (exitCode !== undefined) expect(cliError.exitCode).toBe(exitCode);
    return cliError;
  }
  throw new Error(`expected ${code}`);
}

describe("path normalization", () => {
  it.each([
    ["/agents", "/agents"],
    ["agents", "/agents"],
    ["/v1/agents", "/agents"],
    ["v1/agents", "/agents"],
    ["/v1/agents/", "/agents"],
    ["/v1", "/"],
    ["/v1/", "/"],
    ["/", "/"],
    ["/v1agents", "/v1agents"],
    ["/v1/v1/agents", "/v1/agents"],
    ["https://api.arcopolis.ai/v1/agents?perPage=2", "/agents"],
  ])("%s -> %s (one /v1 stripped, never doubled)", (input, expected) => {
    expect(normalizeApiPath(input).path).toBe(expected);
  });

  it("decodes segments and keeps the query", () => {
    const result = normalizeApiPath("/v1/agents/a%2Fb%20c/posts?page=2&perPage=5");
    expect(result.segments).toEqual(["agents", "a/b c", "posts"]);
    expect(result.path).toBe("/agents/a%2Fb%20c/posts");
    expect(result.query).toEqual([
      ["page", "2"],
      ["perPage", "5"],
    ]);
  });

  it.each(["", "  ", "/agents//x", "/agents/..", "/agents/%2e%2e", "/agents/./x", "/agents#frag", "/agents/%zz", "/agents/a b"])(
    "rejects %j with INVALID_PATH (exit 2)",
    (input) => {
      expectCliError(() => normalizeApiPath(input), "INVALID_PATH", 2);
    },
  );

  it("accepts full URLs only on allowed hosts and never with credentials or http", () => {
    expectCliError(() => normalizeApiPath("https://evil.example/v1/agents"), "INVALID_PATH", 2);
    expectCliError(() => normalizeApiPath("http://api.arcopolis.ai/v1/agents"), "INVALID_PATH", 2);
    expectCliError(() => normalizeApiPath("https://user:pw@api.arcopolis.ai/v1/agents"), "INVALID_PATH", 2);
    expect(normalizeApiPath("https://staging.example/v1/posts", { allowedHosts: ["staging.example"] }).path).toBe("/posts");
  });

  it("stripOneV1 strips exactly one segment", () => {
    expect(stripOneV1("/v1")).toBe("/");
    expect(stripOneV1("/v1/v1/x")).toBe("/v1/x");
    expect(stripOneV1("/v10/x")).toBe("/v10/x");
  });
});

describe("template matching and expansion", () => {
  it("prefers literal segments over parameters", () => {
    const candidates = [
      { name: "param", compiled: compileTemplate("/v1/network/challenges/{id}") },
      { name: "literal", compiled: compileTemplate("/v1/network/challenges/latest") },
    ];
    expect(matchPath(candidates, ["network", "challenges", "latest"])?.target.name).toBe("literal");
    expect(matchPath(candidates, ["network", "challenges", "c1"])).toMatchObject({ target: { name: "param" }, params: { id: "c1" } });
    expect(matchPath(candidates, ["network", "challenges"])).toBeNull();
  });

  it("expands templates with URL-encoded parameters", () => {
    expect(expandTemplate("/agents/{id}/relationships/{otherId}", { id: "a/b c", otherId: "x?y&z" })).toBe(
      "/agents/a%2Fb%20c/relationships/x%3Fy%26z",
    );
    expectCliError(() => expandTemplate("/agents/{id}", {}), "MISSING_ARGUMENT", 2);
    expectCliError(() => expandTemplate("/agents/{id}", { id: ".." }), "INVALID_PATH", 2);
    expectCliError(() => checkPathParam("id", ""), "USAGE_ERROR", 2);
  });

  it("recognizes visitor paths", () => {
    expect(isVisitorPath(["visitors", "a", "journal"])).toBe(true);
    expect(isVisitorPath(["agents"])).toBe(false);
  });

  it("parses --query assignments at the first '='", () => {
    expect(parseQueryAssignments(["a=1", "b=x=y", "c="])).toEqual([
      ["a", "1"],
      ["b", "x=y"],
      ["c", ""],
    ]);
    expectCliError(() => parseQueryAssignments(["novalue"]), "INVALID_FLAG_VALUE", 2);
    expectCliError(() => parseQueryAssignments(["=1"]), "INVALID_FLAG_VALUE", 2);
  });

  it("quotes shell words only when needed", () => {
    expect(shellQuote("agent_1")).toBe("agent_1");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("the bundled snapshot catalog", () => {
  it("every operation carries tier and scopes; commands point at real operations", async () => {
    const operations = await loadOperations();
    expect(operations.length).toBeGreaterThan(20);
    for (const operation of operations) {
      expect(operation.requiredTier, operation.operationId).toEqual(expect.any(Number));
      expect(Array.isArray(operation.requiredScopes)).toBe(true);
    }
    const ids = new Set(operations.map((operation) => operation.operationId));
    for (const id of Object.keys(OPERATION_COMMANDS)) expect(ids.has(id), id).toBe(true);
  });

  it("classifies envelope, visitor, paging, and cost", async () => {
    expect(await getOperation("getApiMetadata")).toMatchObject({ envelope: false, requiredTier: 0, relativePath: "/" });
    expect(await getOperation("listAgents")).toMatchObject({ envelope: true, paged: true, costClass: "paged" });
    expect(await getOperation("getAgent")).toMatchObject({ paged: false, costClass: "single", relativePath: "/agents/{id}" });
    expect(await getOperation("getNetworkGraph")).toMatchObject({ costClass: "expensive", requiredTier: 3 });
    expect(await getOperation("searchContent")).toMatchObject({ costClass: "search" });
    expect(await getOperation("getVisitorJournal")).toMatchObject({ visitor: true, costClass: "budgeted" });
    expect(await getOperation("actAsVisitor")).toMatchObject({ method: "POST", costClass: "write" });
  });

  it("derives untrusted paths from the response schema", async () => {
    expect((await getOperation("listPosts")).untrustedPaths).toEqual(
      expect.arrayContaining(["data[].text", "data[].agentDisplayName", "data[].attachmentText"]),
    );
    expect((await getOperation("getAgent")).untrustedPaths).toEqual(expect.arrayContaining(["data.bio", "data.displayName"]));
    const search = (await getOperation("searchContent")).untrustedPaths;
    expect(search).toEqual(expect.arrayContaining(["data.agents[].bio", "data.posts[].text", "data[].text", "data[].bio"]));
    expect((await getOperation("getNetworkChallenge")).untrustedPaths).toEqual(
      expect.arrayContaining(["data.title", "data.prompt", "data.contributions[].text"]),
    );
    expect((await getOperation("getTopicTimeline")).untrustedPaths).toEqual([]);
    expect((await getOperation("getApiMetadata")).untrustedPaths).toEqual([]);
  });

  it("untrustedPathsForSchema follows refs, allOf, and cycles", () => {
    const doc: OpenApiDocument = {
      paths: {},
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: { text: { type: "string" }, id: { type: "string" }, child: { $ref: "#/components/schemas/Node" } },
          },
          Wrapper: { allOf: [{ $ref: "#/components/schemas/Node" }, { properties: { tags: { type: "array", items: { type: "string" } } } }] },
        },
      },
    };
    expect(untrustedPathsForSchema(doc, { properties: { data: { $ref: "#/components/schemas/Wrapper" } } })).toEqual([
      "data.tags[]",
      "data.text",
    ]);
  });

  it("buildOperations reads parameters, shared path parameters, and tier extensions", () => {
    const doc: OpenApiDocument = {
      paths: {
        "/v1/things/{id}": {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          get: {
            operationId: "getThing",
            tags: ["Things"],
            "x-required-tier": 2,
            "x-required-scopes": ["things:read"],
            parameters: [
              { name: "page", in: "query", schema: { type: "integer" } },
              { name: "perPage", in: "query", schema: { type: "integer", maximum: 100 } },
            ],
            responses: { "200": { content: { "application/json": { schema: { properties: { data: { type: "array" } } } } } } },
          },
        },
      },
    };
    const [operation] = buildOperations(doc);
    expect(operation).toMatchObject({
      operationId: "getThing",
      method: "GET",
      relativePath: "/things/{id}",
      requiredTier: 2,
      requiredScopes: ["things:read"],
      paged: true,
      envelope: true,
      pathParams: [{ name: "id", required: true }],
    });
    expect(describeOperation(operation!)).toMatchObject({ apiGet: true, pathParams: ["id"], command: null });
  });

  it("listOperations lists GETs, filters by tag, and rejects unknown tags", async () => {
    const all = await listOperations();
    expect(all.every((operation) => operation.method === "GET")).toBe(true);
    const intelligence = await listOperations({ tag: "agent-intelligence" });
    expect(intelligence.length).toBeGreaterThan(0);
    expect(intelligence.every((operation) => operation.tags.includes("Agent intelligence"))).toBe(true);
    expect((await listOperations({ includeVisitor: false })).some((operation) => operation.visitor)).toBe(false);
    await expectCliRejection(listOperations({ tag: "nope" }), "INVALID_FLAG_VALUE", 2);
  });

  it("every read command maps to content GET operations with the tier its summary states", async () => {
    for (const spec of readCommands) {
      const ids = (spec.outputSchema["x-operationIds"] as string[] | undefined) ?? [];
      expect(ids.length, spec.name).toBeGreaterThan(0);
      for (const id of ids) {
        const operation = await getOperation(id);
        expect(operation.method, id).toBe("GET");
        expect(operation.visitor, id).toBe(false);
        expect(spec.summary, spec.name).toContain(`tier ${operation.requiredTier}`);
        expect(spec.summary, spec.name).toContain(operation.requiredScopes[0] ?? "");
      }
    }
  });
});

describe("local guards", () => {
  it("assertKeyAllowed checks known tier and scopes only", async () => {
    const memory = await getOperation("getAgentMemory");
    assertKeyAllowed(memory, undefined);
    assertKeyAllowed(memory, { tier: null, scopes: null });
    assertKeyAllowed(memory, { tier: 3, scopes: [] });
    assertKeyAllowed(memory, { tier: 2, scopes: ["intelligence:read"] });
    const tier = expectCliError(() => assertKeyAllowed(memory, { tier: 1 }), "INSUFFICIENT_TIER", 4);
    expect(tier.details).toMatchObject({ requiredTier: 2, keyTier: 1, checkedLocally: true });
    expect(tier.next[0]).toMatchObject({ command: "arcopolis portal", humanDecision: true });
    const scope = expectCliError(() => assertKeyAllowed(memory, { tier: 3, scopes: ["agents:read"] }), "INSUFFICIENT_SCOPE", 4);
    expect(scope.details).toMatchObject({ missingScopes: ["intelligence:read"] });
    assertKeyAllowed(await getOperation("getApiMetadata"), { tier: 0, scopes: ["agents:read"] });
  });

  it("assertExpensiveAllowed needs the flag (exit 10, human decision)", async () => {
    const graph = await getOperation("getNetworkGraph");
    const error = expectCliError(() => assertExpensiveAllowed(graph, false), "CONFIRMATION_REQUIRED", 10);
    expect(error.humanDecision).toBe(true);
    assertExpensiveAllowed(graph, true);
    assertExpensiveAllowed(await getOperation("listAgents"), false);
  });

  it("resolveApiGet refuses visitor paths, unknown paths, POST-only paths, and bad queries", async () => {
    await expectCliRejection(resolveApiGet("/v1/visitors/visitor_ada/journal", []), "VISITOR_PATH_REFUSED", 2);
    await expectCliRejection(resolveApiGet("/visitors/x/nothing", []), "VISITOR_PATH_REFUSED", 2);
    await expectCliRejection(resolveApiGet("/v1/v1/agents", []), "PATH_NOT_IN_OPENAPI", 2);
    const post = await expectCliRejection(resolveApiGet("/agents/a1/complete", []), "PATH_NOT_IN_OPENAPI", 2);
    expect(post.details).toMatchObject({ method: "POST", operationId: "createAgentCompletion" });
    await expectCliRejection(resolveApiGet("/agents", ["bogus=1"]), "INVALID_FLAG_VALUE", 2);
    await expectCliRejection(resolveApiGet("/agents?perPage=2", ["perPage=3"]), "INVALID_FLAG_VALUE", 2);
    await expectCliRejection(resolveApiGet("/agents", ["perPage=101"]), "INVALID_FLAG_VALUE", 2);
    await expectCliRejection(resolveApiGet("/agents", ["page=0"]), "INVALID_FLAG_VALUE", 2);
    await expectCliRejection(resolveApiGet("/search", []), "INVALID_FLAG_VALUE", 2);
  });

  it("resolveApiGet splits page and perPage from the other query parameters", async () => {
    const resolved = await resolveApiGet("/v1/agents?page=3", ["perPage=10", "specialty=urbanism"]);
    expect(resolved).toMatchObject({
      operation: { operationId: "listAgents" },
      query: { specialty: "urbanism" },
      startPage: 3,
      perPage: 10,
      normalizedPath: "/agents",
      queryAssignments: [
        ["perPage", "10"],
        ["specialty", "urbanism"],
      ],
    });
    expect((await resolveApiGet("/v1", [])).operation.operationId).toBe("getApiMetadata");
    expect((await resolveApiGet("/agents/a%2Fb/relationships/c", [])).pathParams).toEqual({ id: "a/b", otherId: "c" });
  });
});

describe("resolveOperationRequest (structured reads for MCP)", () => {
  it("accepts a content GET with exact path parameters and checked query values", async () => {
    const resolved = await resolveOperationRequest({
      operationId: "listAgentPosts",
      pathParams: { id: "a/b" },
      query: { page: 2, perPage: 10, ignored: undefined },
    });
    expect(resolved).toMatchObject({ operationId: "listAgentPosts", pathParams: { id: "a/b" }, query: {}, startPage: 2, perPage: 10 });
    const search = await resolveOperationRequest({ operationId: "searchContent", query: { q: "garden", type: "posts" } });
    expect(search.query).toEqual({ q: "garden", type: "posts" });
  });

  it("refuses unknown, POST, and visitor operations and bad parameters", async () => {
    await expectCliRejection(resolveOperationRequest({ operationId: "nope" }), "PATH_NOT_IN_OPENAPI", 2);
    await expectCliRejection(resolveOperationRequest({ operationId: "createAgentCompletion" }), "PATH_NOT_IN_OPENAPI", 2);
    await expectCliRejection(resolveOperationRequest({ operationId: "getVisitorJournal" }), "VISITOR_PATH_REFUSED", 2);
    await expectCliRejection(resolveOperationRequest({ operationId: "getAgent" }), "MISSING_ARGUMENT", 2);
    await expectCliRejection(resolveOperationRequest({ operationId: "getAgent", pathParams: { id: ".." } }), "INVALID_PATH", 2);
    await expectCliRejection(resolveOperationRequest({ operationId: "getAgent", pathParams: { id: "a", x: "b" } }), "INVALID_FLAG_VALUE", 2);
    await expectCliRejection(resolveOperationRequest({ operationId: "getAgent", pathParams: { id: { a: 1 } } }), "INVALID_FLAG_VALUE", 2);
    await expectCliRejection(resolveOperationRequest({ operationId: "listAgents", query: { bogus: 1 } }), "INVALID_FLAG_VALUE", 2);
    await expectCliRejection(resolveOperationRequest({ operationId: "listAgents", query: { perPage: 1000 } }), "INVALID_FLAG_VALUE", 2);
    await expectCliRejection(resolveOperationRequest({ operationId: "searchContent", query: {} }), "INVALID_FLAG_VALUE", 2);
  });
});

describe("executeRead", () => {
  const base = checkBase(DEFAULT_API_BASE, "data", "default", {});

  it("merges object pages (network graph) and stops at max pages", async () => {
    const fake = fakeFetch((url) => {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      return json(200, {
        data: { follows: [{ from: `a${page}`, to: "b" }], relationships: [] },
        meta: { page, perPage: 1, hasMore: true },
      });
    });
    const client = new HttpClient({ plane: "data", base, key: { value: fakeKey("7"), source: "env" }, userAgent: "test", fetchImpl: fake.fetchImpl });
    const outcome = await executeRead(client, {
      operation: await getOperation("getNetworkGraph"),
      pathParams: {},
      query: { include: "follows" },
      maxPages: 3,
    });
    expect(fake.calls.map((call) => call.url)).toEqual([
      "https://api.arcopolis.ai/v1/network/graph?include=follows",
      "https://api.arcopolis.ai/v1/network/graph?include=follows&page=2",
      "https://api.arcopolis.ai/v1/network/graph?include=follows&page=3",
    ]);
    expect(outcome.data).toEqual({
      follows: [
        { from: "a1", to: "b" },
        { from: "a2", to: "b" },
        { from: "a3", to: "b" },
      ],
      relationships: [],
    });
    expect(outcome.pagination).toMatchObject({ pages: 3, stoppedBecause: "max_pages", hasMore: true, nextPage: 4, items: 3 });
  });

  it("sends one request for a non-paged operation and throws first-page errors", async () => {
    const fake = fakeFetch(() => json(404, { error: { code: "NOT_FOUND", message: "Agent not found" } }));
    const client = new HttpClient({ plane: "data", base, key: { value: fakeKey("7"), source: "env" }, userAgent: "test", fetchImpl: fake.fetchImpl });
    await expectCliRejection(
      executeRead(client, { operation: await getOperation("getAgent"), pathParams: { id: "nope" }, query: {}, maxPages: 5 }),
      "NOT_FOUND",
      5,
    );
    expect(fake.calls).toHaveLength(1);
  });
});

describe("human tables", () => {
  it("renders compact padded tables and strips control characters", () => {
    const table = renderTable(
      [
        { id: "p1", text: "hello\u001b[31m red\u001b[0m\nworld", likeCount: 3 },
        { id: "p2", text: "x".repeat(200), likeCount: null },
      ],
      ["id", "likeCount", "text"],
    );
    const lines = table.split("\n");
    expect(lines[0]).toBe("id  likeCount  text");
    expect(lines[1]).toBe("p1  3          hello red world");
    expect(lines[2]?.endsWith("…")).toBe(true);
    expect(table).not.toContain("\u001b");
    expect(renderTable([])).toBe("(none)");
    expect(sanitizeText("a\u0007b")).toBe("a b");
    expect(cellText(["a", "b"])).toBe("a, b");
    expect(cellText([{ a: 1 }])).toBe("[1 items]");
  });
});
