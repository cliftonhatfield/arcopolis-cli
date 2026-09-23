import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { checkBase, type ResolvedBase } from "../src/core/bases.js";
import { CliError } from "../src/core/errors.js";
import { HttpClient, buildUserAgent, parseRetryAfter, type TransportOptions } from "../src/core/http.js";
import { Effects } from "../src/core/output.js";
import { fakeFetch, fakeKey, json } from "./helpers.js";

const canonical = checkBase("https://api.arcopolis.ai/v1", "data", "default", {});
const key = fakeKey("e");

function client(options: Partial<TransportOptions> & Pick<TransportOptions, "fetchImpl">): HttpClient {
  return new HttpClient({
    plane: "data",
    base: canonical,
    key: { value: key, source: "env", origin: null },
    userAgent: buildUserAgent("0.1.0"),
    ...options,
  });
}

async function expectCliError(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error("expected a CliError");
}

describe("user agent and headers", () => {
  it("builds the plan's User-Agent shape", () => {
    const ua = buildUserAgent("0.1.0");
    expect(ua).toBe(`arcopolis-cli/0.1.0 node/${process.versions.node} ${process.platform}-${process.arch}`);
    expect(buildUserAgent("0.1.0", true)).toBe(`${ua} mcp`);
  });

  it("GET sends Accept, UA, and the key, with no body and no content type", async () => {
    const fake = fakeFetch(() => json(200, { data: [], meta: { page: 1 } }));
    const response = await client({ fetchImpl: fake.fetchImpl }).get("/v1/agents", { perPage: 5, page: undefined, specialty: null });
    const call = fake.calls[0];
    expect(call?.url).toBe("https://api.arcopolis.ai/v1/agents?perPage=5");
    expect(call?.init.method).toBe("GET");
    expect(call?.init.body).toBeUndefined();
    expect(call?.init.redirect).toBe("manual");
    expect(call?.headers.accept).toBe("application/json");
    expect(call?.headers["user-agent"]).toBe(buildUserAgent("0.1.0"));
    expect(call?.headers["x-api-key"]).toBe(key);
    expect(call?.headers["content-type"]).toBeUndefined();
    expect(call?.headers["transfer-encoding"]).toBeUndefined();
    expect(response.meta).toEqual({ page: 1 });
  });

  it("POST sends a JSON body and the Idempotency-Key", async () => {
    const fake = fakeFetch(() => json(200, { data: { ok: true } }));
    await client({ fetchImpl: fake.fetchImpl }).post("/visitors/a/heartbeat", {}, { idempotencyKey: "heartbeat-1", purpose: "heartbeat" });
    const call = fake.calls[0];
    expect(call?.init.body).toBe("{}");
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(call?.headers["idempotency-key"]).toBe("heartbeat-1");
  });

  it("GET /v1 metadata is unwrapped when envelope is false", async () => {
    const fake = fakeFetch(() => json(200, { name: "AGNTS Public API", version: "1.0.0" }));
    const response = await client({ fetchImpl: fake.fetchImpl }).get("/v1", undefined, { envelope: false });
    expect(fake.calls[0]?.url).toBe("https://api.arcopolis.ai/v1");
    expect(response.data).toEqual({ name: "AGNTS Public API", version: "1.0.0" });
    await expect(client({ fetchImpl: fake.fetchImpl }).get("/")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("records requests, network, and a rateLimit spend", async () => {
    const effects = new Effects();
    const fake = fakeFetch(() => json(200, { data: {} }));
    await client({ fetchImpl: fake.fetchImpl, effects }).get("/trending");
    expect(effects.snapshot()).toMatchObject({ network: ["data"], requests: 1, spends: { rateLimit: 1 } });
  });
});

describe("response handling", () => {
  it("HTML 400 is NON_JSON_RESPONSE with a redacted excerpt", async () => {
    const fake = fakeFetch(
      () => new Response(`<html>Bad Request ${fakeKey("f")}</html>`, { status: 400, headers: { "content-type": "text/html" } }),
    );
    const error = await expectCliError(client({ fetchImpl: fake.fetchImpl }).post("/visitors/a/act", { like: { postId: "p" } }));
    expect(error.code).toBe("NON_JSON_RESPONSE");
    expect(error.exitCode).toBe(11);
    expect(error.surface).toBe("edge");
    expect(JSON.stringify(error.details)).not.toContain(fakeKey("f"));
    expect((error.details?.excerpt as string).length).toBeLessThanOrEqual(200);
  });

  it("text 403 containing error code: 1010 is EDGE_BLOCKED", async () => {
    const fake = fakeFetch(() => new Response("error code: 1010", { status: 403, headers: { "content-type": "text/plain" } }));
    const error = await expectCliError(client({ fetchImpl: fake.fetchImpl }).get("/agents"));
    expect(error.code).toBe("EDGE_BLOCKED");
    expect(error.exitCode).toBe(11);
    expect(error.details).toMatchObject({ status: 403, contentType: "text/plain" });
  });

  it("non-JSON 5xx is NON_JSON_RESPONSE and is never retried", async () => {
    const fake = fakeFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
    const error = await expectCliError(client({ fetchImpl: fake.fetchImpl }).get("/agents"));
    expect(error.code).toBe("NON_JSON_RESPONSE");
    expect(error.httpStatus).toBe(502);
    expect(fake.calls).toHaveLength(1);
  });

  it("JSON is parsed only on a JSON content type", async () => {
    const fake = fakeFetch(() => new Response('{"data":{}}', { status: 200, headers: { "content-type": "text/plain" } }));
    const error = await expectCliError(client({ fetchImpl: fake.fetchImpl }).get("/agents"));
    expect(error.code).toBe("NON_JSON_RESPONSE");
  });

  it("maps API errors and passes details through", async () => {
    const fake = fakeFetch(() => json(401, { error: { code: "INVALID_API_KEY", message: "Invalid API key" } }));
    const error = await expectCliError(client({ fetchImpl: fake.fetchImpl }).get("/agents"));
    expect(error).toMatchObject({ code: "INVALID_API_KEY", exitCode: 3, httpStatus: 401, surface: "data" });
    expect(error.details).toEqual({ reasonCode: null, candidates: null, invocationId: null });
  });

  it("parses Retry-After as seconds", async () => {
    const fake = fakeFetch(() => json(429, { error: { code: "RATE_LIMIT_EXCEEDED", message: "Slow down" } }, { "retry-after": "7" }));
    const error = await expectCliError(client({ fetchImpl: fake.fetchImpl }).get("/agents"));
    expect(error.exitCode).toBe(6);
    expect(error.retry).toEqual({ strategy: "after_seconds", afterSeconds: 7 });
  });

  it("parses Retry-After as an HTTP date", async () => {
    const now = new Date("2026-09-23T05:00:00.000Z");
    const later = new Date(now.getTime() + 30_000).toUTCString();
    const fake = fakeFetch(() => json(429, { error: { code: "RATE_LIMIT_EXCEEDED", message: "x" } }, { "retry-after": later }));
    const error = await expectCliError(client({ fetchImpl: fake.fetchImpl, now: () => now }).get("/agents"));
    expect(error.retry).toEqual({ strategy: "after_seconds", afterSeconds: 30 });
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });

  it("timeouts are TIMEOUT on reads and WRITE_TIMEOUT on writes", async () => {
    const hang: Parameters<typeof fakeFetch>[0] = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const read = await expectCliError(client({ fetchImpl: fakeFetch(hang).fetchImpl, timeoutMs: 20 }).get("/agents"));
    expect(read).toMatchObject({ code: "TIMEOUT", exitCode: 12 });
    const write = await expectCliError(client({ fetchImpl: fakeFetch(hang).fetchImpl, timeoutMs: 20 }).post("/visitors/a/act", {}));
    expect(write).toMatchObject({ code: "WRITE_TIMEOUT", exitCode: 9 });
    expect(write.retry.strategy).toBe("same_request_only");
  });

  it("network errors are NETWORK_ERROR on reads and WRITE_NETWORK_ERROR on writes", async () => {
    const fail = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    await expect(client({ fetchImpl: fail.fetchImpl }).get("/agents")).rejects.toMatchObject({ code: "NETWORK_ERROR", exitCode: 12 });
    await expect(client({ fetchImpl: fail.fetchImpl }).post("/visitors/a/act", {})).rejects.toMatchObject({
      code: "WRITE_NETWORK_ERROR",
      exitCode: 9,
    });
  });
});

describe("bases and key binding", () => {
  it("refuses a non-loopback http base", () => {
    const bogus: ResolvedBase = { url: "http://api.example.com/v1", origin: "http://api.example.com", host: "api.example.com", kind: "custom", source: "env" };
    expect(() => client({ fetchImpl: fakeFetch(() => json(200, {})).fetchImpl, base: bogus })).toThrow(CliError);
    expect(() => checkBase("http://api.example.com/v1", "data", "env", { ARCOPOLIS_ALLOW_CUSTOM_BASE: "1" })).toThrow(/HTTPS/);
  });

  it("a custom host never receives a stored key", async () => {
    const custom = checkBase("https://staging.example.com/v1", "data", "env", { ARCOPOLIS_ALLOW_CUSTOM_BASE: "1" });
    const hosts: string[] = [];
    const fake = fakeFetch(() => json(200, { data: {} }));
    const stored = client({
      fetchImpl: fake.fetchImpl,
      base: custom,
      key: { value: key, source: "store", origin: custom.origin },
      onCustomHost: (host) => hosts.push(host),
    });
    const error = await expectCliError(stored.get("/agents"));
    expect(error.code).toBe("STORED_KEY_ORIGIN_MISMATCH");
    expect(error.exitCode).toBe(3);
    expect(fake.calls).toHaveLength(0);

    const fromEnv = client({ fetchImpl: fake.fetchImpl, base: custom, key: { value: key, source: "env" }, onCustomHost: (host) => hosts.push(host) });
    await fromEnv.get("/agents");
    expect(fake.calls[0]?.headers["x-api-key"]).toBe(key);
    expect(hosts).toEqual(["staging.example.com"]);
  });

  it("a stored key is sent only to its recorded origin", async () => {
    const fake = fakeFetch(() => json(200, { data: {} }));
    const loopback = checkBase("http://127.0.0.1:9/v1", "data", "env", {});
    const mismatched = client({ fetchImpl: fake.fetchImpl, base: loopback, key: { value: key, source: "store", origin: "https://api.arcopolis.ai" } });
    await expect(mismatched.get("/agents")).rejects.toMatchObject({ code: "STORED_KEY_ORIGIN_MISMATCH" });
    const matched = client({ fetchImpl: fake.fetchImpl, key: { value: key, source: "store", origin: "https://api.arcopolis.ai" } });
    await matched.get("/agents");
    expect(fake.calls).toHaveLength(1);
  });
});

describe("redirects (loopback servers)", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    servers.length = 0;
  });

  async function listen(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("a 3xx gives REDIRECT_REJECTED and the key is never forwarded", async () => {
    const seenByTarget: Array<string | undefined> = [];
    const target = await listen((req, res) => {
      seenByTarget.push(req.headers["x-api-key"] as string | undefined);
      res.writeHead(200, { "content-type": "application/json" }).end('{"data":{}}');
    });
    const origin = await listen((_req, res) => {
      res.writeHead(302, { location: `${target}/v1/agents` }).end();
    });
    const base = checkBase(`${origin}/v1`, "data", "env", {});
    const real = new HttpClient({
      plane: "data",
      base,
      key: { value: key, source: "env" },
      userAgent: buildUserAgent("0.1.0"),
    });
    const error = await expectCliError(real.get("/agents"));
    expect(error.code).toBe("REDIRECT_REJECTED");
    expect(error.exitCode).toBe(11);
    expect(error.httpStatus).toBe(302);
    expect(seenByTarget).toEqual([]);
  });
});
