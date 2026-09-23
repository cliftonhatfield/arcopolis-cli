/** Unit tests for the MCP local guards and the result redaction (plan §6). */
import { describe, expect, it } from "vitest";
import { CliError } from "../src/core/errors.js";
import { Effects, buildErrorDocument, buildSuccessDocument } from "../src/core/output.js";
import { HEARTBEAT_MIN_INTERVAL_MINUTES, RequestGuard, assertHeartbeatCadence, lastCachedHeartbeatAt } from "../src/mcp/guards.js";
import { redactForClient, toolError, toolSuccess } from "../src/mcp/response.js";
import { emptyVisitorCache } from "../src/visitor/cache.js";
import { fakeKey } from "./helpers.js";

const T0 = new Date("2026-09-23T15:00:00.000Z");

function thrown(fn: () => void): CliError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a CliError");
}

describe("RequestGuard", () => {
  it("admits up to the per-minute limit and says when the oldest slot frees", () => {
    let now = T0;
    const guard = new RequestGuard({ perMinute: 3, perProcess: 100, windowMs: 60_000 }, () => now);
    guard.reserve(1);
    now = new Date(T0.getTime() + 20_000);
    guard.reserve(2);
    const error = thrown(() => guard.reserve(1));
    expect(error).toMatchObject({ code: "LOCAL_RATE_LIMIT", exitCode: 6, category: "rate_limited", retry: { strategy: "after_seconds", afterSeconds: 40 } });
    now = new Date(T0.getTime() + 60_001);
    expect(guard.reserve(1)).toHaveLength(1);
    expect(guard.usage()).toMatchObject({ lastMinute: 3, total: 4 });
  });

  it("refuses a single call larger than the minute limit with no retry advice", () => {
    const guard = new RequestGuard({ perMinute: 3, perProcess: 100, windowMs: 60_000 }, () => T0);
    expect(thrown(() => guard.reserve(4))).toMatchObject({ code: "LOCAL_RATE_LIMIT", retry: { strategy: "none" } });
    expect(guard.usage().total).toBe(0);
  });

  it("leases return unused slots and claim extra slots on demand", () => {
    const guard = new RequestGuard({ perMinute: 5, perProcess: 5, windowMs: 60_000 }, () => T0);
    const lease = guard.lease();
    lease.reserve(3);
    lease.take();
    lease.settle();
    expect(guard.usage()).toMatchObject({ lastMinute: 1, total: 1 });
    const second = guard.lease();
    second.take();
    second.take();
    second.settle();
    expect(second.requests).toBe(2);
    expect(guard.usage().total).toBe(3);
    const third = guard.lease();
    third.reserve(2);
    expect(
      thrown(() => {
        third.take();
        third.take();
        third.take();
      }),
    ).toMatchObject({
      code: "LOCAL_RATE_LIMIT",
      details: { scope: "process" },
    });
  });

  it("the per-process cap needs a human", () => {
    const guard = new RequestGuard({ perMinute: 100, perProcess: 2, windowMs: 60_000 }, () => T0);
    guard.reserve(2);
    expect(thrown(() => guard.reserve(1))).toMatchObject({ code: "LOCAL_RATE_LIMIT", humanDecision: true, retry: { strategy: "after_human" } });
  });
});

describe("heartbeat cadence guard", () => {
  it("refuses within 10 minutes and passes at 10", () => {
    expect(HEARTBEAT_MIN_INTERVAL_MINUTES).toBe(10);
    const last = new Date(T0.getTime() - 9 * 60_000).toISOString();
    expect(thrown(() => assertHeartbeatCadence({ lastAt: last, now: T0, recommendedMinutes: 20 }))).toMatchObject({
      code: "LOCAL_CADENCE_GUARD",
      exitCode: 6,
      retry: { strategy: "after_seconds", afterSeconds: 60 },
      details: { minutesSinceLast: 9, nextAllowedAt: "2026-09-23T15:01:00.000Z" },
    });
    expect(() => assertHeartbeatCadence({ lastAt: new Date(T0.getTime() - 10 * 60_000).toISOString(), now: T0, recommendedMinutes: 20 })).not.toThrow();
    expect(() => assertHeartbeatCadence({ lastAt: null, now: T0, recommendedMinutes: 20 })).not.toThrow();
  });

  it("uses the later of the server time and the local receipt time", () => {
    const cache = emptyVisitorCache("visitor_ada", "https://api.arcopolis.ai/v1");
    expect(lastCachedHeartbeatAt(cache)).toBeNull();
    cache.lastHeartbeat = { receivedAt: "2026-09-23T14:55:00.000Z", data: { heartbeatAt: "2026-09-23T14:56:00.000Z" } };
    expect(lastCachedHeartbeatAt(cache)).toBe("2026-09-23T14:56:00.000Z");
  });
});

describe("result redaction", () => {
  const key = fakeKey("d");

  it("redacts values, header-named fields, and property names", () => {
    const value = redactForClient({ text: `key ${key}`, [key]: 1, headers: { "X-API-Key": "abc", authorization: "Bearer x" } });
    const text = JSON.stringify(value);
    expect(text).not.toContain(key);
    expect(text).not.toContain("Bearer x");
    expect(value).toMatchObject({ headers: { "X-API-Key": "[redacted]", authorization: "[redacted]" } });
  });

  it("toolSuccess and toolError never carry a key", () => {
    const doc = buildSuccessDocument("arcopolis_read", { data: { bio: key } }, new Effects(false).snapshot(), []);
    const success = toolSuccess("arcopolis_read", `summary ${key}`, doc);
    expect(JSON.stringify(success)).not.toContain(key);
    const error = buildErrorDocument("arcopolis_read", new CliError("INVALID_API_KEY", `bad ${key}`, { httpStatus: 401 }), new Effects(false).snapshot(), []);
    const failure = toolError("arcopolis_read", error);
    expect(failure.isError).toBe(true);
    expect(failure.structuredContent).toMatchObject({ error: { code: "INVALID_API_KEY", category: "auth", toolName: "arcopolis_read", exitCode: 3 } });
    expect(JSON.stringify(failure)).not.toContain(key);
  });

  it("the JSON in a text result stays parseable when other agents' text holds a header name and an escaped quote", () => {
    const text = 'my Authorization: abc"def and X-API-Key=a"b';
    const doc = buildSuccessDocument("arcopolis_read", { data: { posts: [{ text }] } }, new Effects(false).snapshot(), []);
    const success = toolSuccess("arcopolis_read", "1 post", doc);
    const content = (success.content[0] as { text: string }).text;
    const parsed = JSON.parse(content.slice(content.indexOf("\n\n") + 2)) as { data: { posts: Array<{ text: string }> } };
    expect(parsed.data.posts[0]?.text).toBe('my Authorization: [redacted]"def and X-API-Key=[redacted]"b');
    expect(success.structuredContent).toMatchObject({ data: { posts: [{ text: 'my Authorization: [redacted]"def and X-API-Key=[redacted]"b' }] } });
  });
});
