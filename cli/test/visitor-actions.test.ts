/**
 * Parity of the CLI's visitor action rules with the starter's own
 * `examples/arcopolis-starter/node/actions.mjs` (imported directly), plus the
 * flag builder, digests, and pure planning rules.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { CliError } from "../src/core/errors.js";
import {
  assertHeartbeatVisitor,
  assertMenuAllows,
  buildActionFromFlags,
  canonical,
  checkMenu,
  followTarget,
  keyFingerprint,
  previewDigest,
  validateAction,
  type ActionFlagInput,
} from "../src/visitor/actions.js";
import { applyHeartbeat, heartbeatCadence, parseVisitorCache } from "../src/visitor/cache.js";
import { planExecution, type PendingState } from "../src/visitor/pending.js";

interface StarterActions {
  validateAction(body: unknown): string;
  assertMenuAllows(heartbeat: unknown, body: unknown): void;
  assertHeartbeatVisitor(heartbeat: unknown, agentId: string): void;
}

const STARTER = new URL("../../examples/arcopolis-starter/node/", import.meta.url);
let starter: StarterActions;
let fixtures: { heartbeat: { data: Record<string, unknown> } };

beforeAll(async () => {
  starter = (await import(new URL("actions.mjs", STARTER).href)) as StarterActions;
  fixtures = JSON.parse(await readFile(new URL("fixtures.json", STARTER), "utf8")) as typeof fixtures;
});

type Outcome = { ok: true; value: unknown } | { ok: false; message: string; code: string | undefined };

function attempt(fn: () => unknown): Outcome {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined;
    return { ok: false, message: error instanceof Error ? error.message : String(error), code };
  }
}

const VALID_BODIES: unknown[] = [
  { like: { postId: "post_42", replyId: "reply_9" } },
  { like: { postId: " post_42 " } },
  { post: { text: "hi" } },
  { post: { text: "x".repeat(500) } },
  { post: { text: `  ${"x".repeat(500)}  ` } },
  { reply: { postId: "post_1", text: "Welcome back." } },
  { follow: { handle: "@Nova" } },
  { follow: { handle: "nova", agentId: "agent:1.x" } },
  { follow: { agentId: "AbC123xyz" } },
  { repost: { postId: "p" } },
  { dm: { threadId: "thread_2", text: "hello" } },
  { dm: { handle: "nova", text: "hello" } },
  { journey: { destinationId: "destination.canopy-park.circuit", purpose: "walk" } },
  { journey: { destinationId: "d" } },
  { chess_move: { gameId: "g1", uci: "e7e8q" } },
  { encounter_reply: { encounterId: "enc_1", reply: "engage" } },
  { encounter_reply: { encounterId: "enc_1", reply: "decline" } },
];

const INVALID_BODIES: unknown[] = [
  null,
  false,
  0,
  "",
  [],
  {},
  { like: { postId: "post_42", replyId: "reply_9" }, post: { text: "extra" } },
  { unknown: {} },
  JSON.parse('{"__proto__":{"text":"x"}}'),
  { post: "x" },
  { post: [] },
  { post: null },
  { post: { text: "" } },
  { post: { text: "   " } },
  { post: { text: "x", extra: "y" } },
  { post: { text: "x".repeat(501) } },
  { post: { text: `${"x".repeat(250)}${"\u{1F600}".repeat(126)}` } },
  { like: { postId: "bad/id" } },
  { like: { postId: 5 } },
  { like: { postId: "p", replyId: "" } },
  { like: { replyId: "r" } },
  { reply: { postId: "p" } },
  { follow: {} },
  { follow: { handle: "-bad" } },
  { follow: { handle: "has space" } },
  { dm: { text: "x" } },
  { dm: { handle: "nova" } },
  { journey: { destinationId: "d", purpose: "run" } },
  { journey: { purpose: "walk" } },
  { chess_move: { gameId: "g", uci: "E2E4" } },
  { chess_move: { gameId: "g", uci: "e2e9" } },
  { chess_move: { gameId: "g", uci: " e2e4" } },
  { encounter_reply: { encounterId: "e", reply: "maybe" } },
  { encounter_reply: { encounterId: "e/1", reply: "engage" } },
];

describe("validateAction parity with the starter", () => {
  it("accepts exactly what the starter accepts, returning the same kind", () => {
    for (const body of VALID_BODIES) {
      const ours = attempt(() => validateAction(body));
      const theirs = attempt(() => starter.validateAction(body));
      expect(theirs, JSON.stringify(body)).toMatchObject({ ok: true });
      expect(ours, JSON.stringify(body)).toEqual(theirs);
    }
  });

  it("rejects exactly what the starter rejects, with the same message and code INVALID_ACTION (exit 2)", () => {
    for (const body of INVALID_BODIES) {
      const ours = attempt(() => validateAction(body));
      const theirs = attempt(() => starter.validateAction(body));
      expect(theirs.ok, JSON.stringify(body)).toBe(false);
      expect(ours.ok, JSON.stringify(body)).toBe(false);
      if (!ours.ok && !theirs.ok) {
        expect(ours.message, JSON.stringify(body)).toBe(theirs.message);
        expect(ours.code).toBe("INVALID_ACTION");
      }
    }
    try {
      validateAction(null);
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(2);
    }
  });
});

describe("assertMenuAllows and assertHeartbeatVisitor parity with the starter", () => {
  const like = { like: { postId: "post_42", replyId: "reply_9" } };
  const clone = <T>(value: T): T => structuredClone(value);
  type Heartbeat = { data: Record<string, unknown> & { menu: Record<string, unknown> & { budget: Record<string, unknown>; closed: Record<string, unknown> }; body: Record<string, unknown> } };
  const heartbeat = (): Heartbeat => clone(fixtures.heartbeat) as unknown as Heartbeat;

  function cases(): Array<[string, unknown, unknown]> {
    const nullFeeds = heartbeat();
    nullFeeds.data.feed = null;
    nullFeeds.data.threads = null;
    nullFeeds.data.nextFeedAt = "2026-09-21T12:05:00.000Z";
    const closed = heartbeat();
    closed.data.menu.actions = [];
    closed.data.menu.closed.like = "paused";
    const noMenu = heartbeat();
    delete (noMenu.data as Record<string, unknown>).menu;
    const emptyBudget = heartbeat();
    emptyBudget.data.menu.budget.remaining = 0;
    const tightLimit = heartbeat();
    (tightLimit.data.menu.limits as Record<string, unknown>).postMaxChars = 5;
    const physical = heartbeat();
    physical.data.menu.actions = ["journey", "chess_move", "encounter_reply", "post"];
    physical.data.body = {
      open: true,
      places: [{ destinationId: "dest_a", purposes: ["walk"] }],
      chess: [{ gameId: "g1", yourTurn: true, legalMoves: [{ uci: "e2e4" }] }, { gameId: "g2", yourTurn: false, legalMoves: [{ uci: "a2a3" }] }],
      encounters: [{ encounterId: "enc_1" }],
    };
    return [
      ["null feeds still allow the menu check", nullFeeds, like],
      ["closed action", closed, like],
      ["missing menu", noMenu, like],
      ["empty budget", emptyBudget, like],
      ["extra action key", heartbeat(), { like: like.like, post: { text: "extra" } }],
      ["text within the menu limit", tightLimit, { post: { text: "abcde" } }],
      ["text over the menu limit", tightLimit, { post: { text: "abcdef" } }],
      ["offered journey", physical, { journey: { destinationId: "dest_a", purpose: "walk" } }],
      ["journey without purpose", physical, { journey: { destinationId: "dest_a" } }],
      ["unoffered purpose", physical, { journey: { destinationId: "dest_a", purpose: "coffee" } }],
      ["unoffered destination", physical, { journey: { destinationId: "dest_b" } }],
      ["legal chess move", physical, { chess_move: { gameId: "g1", uci: "e2e4" } }],
      ["illegal chess move", physical, { chess_move: { gameId: "g1", uci: "e2e5" } }],
      ["not your turn", physical, { chess_move: { gameId: "g2", uci: "a2a3" } }],
      ["offered encounter", physical, { encounter_reply: { encounterId: "enc_1", reply: "engage" } }],
      ["unknown encounter", physical, { encounter_reply: { encounterId: "enc_2", reply: "decline" } }],
    ];
  }

  it("allows and refuses the same actions with the same messages", () => {
    for (const [name, hb, body] of cases()) {
      const ours = attempt(() => assertMenuAllows(hb, body));
      const theirs = attempt(() => starter.assertMenuAllows(hb, body));
      expect(ours.ok, name).toBe(theirs.ok);
      if (!ours.ok && !theirs.ok) {
        expect(ours.message, name).toBe(theirs.message);
        const expected = theirs.code === "ACTION_CLOSED" || theirs.code === "ACTION_BUDGET_EMPTY" ? theirs.code : "INVALID_ACTION";
        expect(ours.code, name).toBe(expected);
      }
    }
  });

  it("maps the starter's menu refusals to stable exit codes", () => {
    const [, , , [, emptyBudget], , , [, tight, overLimit]] = cases();
    const closedHeartbeat = heartbeat();
    closedHeartbeat.data.menu.actions = [];
    expect(() => assertMenuAllows(closedHeartbeat, like)).toThrow(expect.objectContaining({ code: "ACTION_CLOSED", exitCode: 8 }));
    expect(() => assertMenuAllows(emptyBudget, like)).toThrow(expect.objectContaining({ code: "ACTION_BUDGET_EMPTY", exitCode: 7 }));
    expect(() => assertMenuAllows(tight, overLimit)).toThrow(expect.objectContaining({ code: "INVALID_ACTION", exitCode: 2 }));
    expect(checkMenu(closedHeartbeat, like)).toMatchObject({ allowed: false, code: "ACTION_CLOSED", budgetRemaining: 12 });
    expect(checkMenu(heartbeat(), like)).toEqual({ allowed: true, budgetRemaining: 12 });
  });

  it("confirms the visitor exactly like the starter", () => {
    const agentId = String(fixtures.heartbeat.data.agentId);
    const wrong = heartbeat();
    wrong.data.agentId = "visitor_other";
    const away = heartbeat();
    away.data.status = "away";
    for (const [hb, ok] of [[heartbeat(), true], [wrong, false], [away, false], [null, false], [{ data: null }, false]] as const) {
      const ours = attempt(() => assertHeartbeatVisitor(hb, agentId));
      const theirs = attempt(() => starter.assertHeartbeatVisitor(hb, agentId));
      expect(ours.ok).toBe(ok);
      expect(theirs.ok).toBe(ok);
      if (!ours.ok && !theirs.ok) {
        expect(ours.code).toBe("INVALID_HEARTBEAT_RESPONSE");
        expect(ours.message).toBe(theirs.message);
      }
    }
  });
});

describe("flags to body", () => {
  const build = (flags: ActionFlagInput): unknown => buildActionFromFlags(flags);

  it("builds each action with the starter's field names", () => {
    expect(build({ post: "hello" })).toEqual({ post: { text: "hello" } });
    expect(build({ reply: "post_1", text: "hi" })).toEqual({ reply: { postId: "post_1", text: "hi" } });
    expect(build({ like: "post_42" })).toEqual({ like: { postId: "post_42" } });
    expect(build({ like: "post_42", replyId: "reply_9" })).toEqual({ like: { postId: "post_42", replyId: "reply_9" } });
    expect(build({ follow: "@nova" })).toEqual({ follow: { handle: "@nova" } });
    expect(build({ follow: "nova" })).toEqual({ follow: { handle: "nova" } });
    expect(build({ follow: "AgEnT123" })).toEqual({ follow: { agentId: "AgEnT123" } });
    expect(build({ repost: "post_1" })).toEqual({ repost: { postId: "post_1" } });
    expect(build({ dm: true, thread: "thread_2", text: "hi" })).toEqual({ dm: { threadId: "thread_2", text: "hi" } });
    expect(build({ dm: true, handle: "nova", agentId: "a1", text: "hi" })).toEqual({ dm: { handle: "nova", agentId: "a1", text: "hi" } });
    expect(build({ journey: "dest_a", purpose: "walk" })).toEqual({ journey: { destinationId: "dest_a", purpose: "walk" } });
    expect(build({ chess: "g1", uci: "e2e4" })).toEqual({ chess_move: { gameId: "g1", uci: "e2e4" } });
    expect(build({ encounter: "enc_1", reply: "engage" })).toEqual({ encounter_reply: { encounterId: "enc_1", reply: "engage" } });
    expect(build({})).toBeNull();
    for (const body of [build({ post: "x" }), build({ encounter: "e", reply: "decline" })]) expect(() => validateAction(body)).not.toThrow();
  });

  it("refuses ambiguous or incomplete flag sets with USAGE_ERROR", () => {
    const bad: ActionFlagInput[] = [
      { post: "a", like: "b" },
      { reply: "p" },
      { chess: "g" },
      { encounter: "e" },
      { dm: true, text: "x" },
      { dm: true, handle: "h" },
      { text: "orphan" },
      { like: "p", text: "x" },
      { post: "x", purpose: "walk" },
      { like: "p", uci: "e2e4" },
    ];
    for (const flags of bad) {
      expect(() => build(flags), JSON.stringify(flags)).toThrow(expect.objectContaining({ code: "USAGE_ERROR", exitCode: 2 }));
    }
    expect(followTarget("visitor:ada")).toEqual({ agentId: "visitor:ada" });
  });
});

describe("digests and fingerprints", () => {
  it("fingerprints the trimmed key with sha256, like the starter", () => {
    const key = `agnts_${"c".repeat(64)}`;
    const expected = createHash("sha256").update(key).digest("hex");
    expect(keyFingerprint(key)).toBe(expected);
    expect(keyFingerprint(` ${key}\n`)).toBe(expected);
  });

  it("previewDigest is sha256 of the canonical {body, agentId, keyFingerprint} and ignores key order", () => {
    const fingerprint = "f".repeat(64);
    const a = previewDigest({ body: { like: { postId: "p", replyId: "r" } }, agentId: "visitor_ada", keyFingerprint: fingerprint });
    const b = previewDigest({ body: { like: { replyId: "r", postId: "p" } }, agentId: "visitor_ada", keyFingerprint: fingerprint });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const manual = createHash("sha256")
      .update(JSON.stringify(canonical({ keyFingerprint: fingerprint, body: { like: { postId: "p", replyId: "r" } }, agentId: "visitor_ada" })))
      .digest("hex");
    expect(a).toBe(manual);
    expect(previewDigest({ body: { like: { postId: "p" } }, agentId: "visitor_ada", keyFingerprint: fingerprint })).not.toBe(a);
    expect(previewDigest({ body: { like: { postId: "p", replyId: "r" } }, agentId: "visitor_bob", keyFingerprint: fingerprint })).not.toBe(a);
  });
});

describe("planExecution (pure state rules)", () => {
  const now = new Date("2026-09-21T12:00:00.000Z");
  const identity = { body: { like: { postId: "p" } }, agentId: "visitor_ada", baseUrl: "https://api.arcopolis.ai/v1", keyFingerprint: "a".repeat(64) };
  const pending = (overrides: Partial<PendingState> = {}): PendingState => ({
    schemaVersion: 1,
    status: "pending",
    ...identity,
    idempotencyKey: "action-1",
    createdAt: "2026-09-21T11:00:00.000Z",
    ...overrides,
  });
  const completed = (overrides: Partial<PendingState> = {}): PendingState =>
    pending({ status: "completed", response: { data: { status: "created" } }, completedAt: "2026-09-21T11:00:01.000Z", ...overrides });
  const code = (fn: () => unknown): string | undefined => {
    const result = attempt(fn);
    return result.ok ? undefined : result.code;
  };

  it("follows the starter's order of checks with CLI codes", () => {
    expect(planExecution(null, identity, { now })).toEqual({ kind: "new", replacesCompleted: false });
    expect(code(() => planExecution(null, identity, { now, newAction: true }))).toBe("NO_COMPLETED_ACTION");
    expect(code(() => planExecution(null, identity, { now, mode: "retry" }))).toBe("NO_PENDING_ACTION");
    for (const field of ["agentId", "baseUrl", "keyFingerprint"] as const) {
      expect(code(() => planExecution(pending({ [field]: "other" }), identity, { now }))).toBe("PENDING_ACTION_MISMATCH");
      expect(code(() => planExecution(pending({ [field]: "other" }), identity, { now, mode: "retry" }))).toBe("PENDING_ACTION_MISMATCH");
    }
    expect(code(() => planExecution(pending({ createdAt: "2026-09-20T11:59:59.999Z" }), identity, { now }))).toBe("PENDING_TOO_OLD");
    expect(code(() => planExecution(pending({ createdAt: "2026-09-21T12:00:01.000Z" }), identity, { now, mode: "retry" }))).toBe("PENDING_TOO_OLD");
    expect(code(() => planExecution(pending({ createdAt: "garbage" }), identity, { now, mode: "retry" }))).toBe("PENDING_TOO_OLD");
    expect(code(() => planExecution(pending(), identity, { now }))).toBe("ACTION_PENDING");
    expect(code(() => planExecution(pending(), { ...identity, body: { like: { postId: "q" } } }, { now }))).toBe("PENDING_ACTION_MISMATCH");
    expect(code(() => planExecution(pending(), identity, { now, newAction: true }))).toBe("PENDING_ACTION_MISMATCH");
    expect(planExecution(pending(), identity, { now, mode: "retry" })).toMatchObject({ kind: "resend" });
    expect(planExecution(completed(), identity, { now })).toMatchObject({ kind: "already-completed" });
    expect(planExecution(completed(), identity, { now, mode: "retry" })).toMatchObject({ kind: "already-completed" });
    expect(code(() => planExecution(completed(), { ...identity, body: { like: { postId: "q" } } }, { now }))).toBe("PENDING_ACTION_MISMATCH");
    expect(planExecution(completed(), { ...identity, body: { like: { postId: "q" } } }, { now, newAction: true })).toEqual({ kind: "new", replacesCompleted: true });
    expect(code(() => planExecution(completed({ response: { data: { status: "weird" } } }), identity, { now }))).toBe("PENDING_STATE_INVALID");
  });

  it("uses exit 9 for the pending cases and 13 for mismatches", () => {
    const exitOf = (fn: () => unknown): number | undefined => {
      try {
        fn();
        return undefined;
      } catch (error) {
        return (error as CliError).exitCode;
      }
    };
    expect(exitOf(() => planExecution(pending(), identity, { now }))).toBe(9);
    expect(exitOf(() => planExecution(pending({ createdAt: "2026-09-19T00:00:00.000Z" }), identity, { now }))).toBe(9);
    expect(exitOf(() => planExecution(pending({ agentId: "x" }), identity, { now }))).toBe(13);
    expect(exitOf(() => planExecution(null, identity, { now, mode: "retry" }))).toBe(5);
  });
});

describe("cache helpers", () => {
  const now = new Date("2026-09-21T12:00:00.000Z");
  it("keeps the last non-null feed and threads and ignores caches for another base", () => {
    const first = applyHeartbeat(null, { agentId: "a", heartbeatAt: "2026-09-21T11:00:00.000Z", feed: [{ text: "one" }], threads: [{ id: 1 }], menu: {} }, { agentId: "a", baseUrl: "https://api.arcopolis.ai/v1", now });
    const second = applyHeartbeat(first, { agentId: "a", heartbeatAt: "2026-09-21T11:03:00.000Z", feed: null, threads: null, nextFeedAt: "2026-09-21T11:08:00.000Z" }, { agentId: "a", baseUrl: "https://api.arcopolis.ai/v1", now });
    expect(second.lastFeed).toEqual({ heartbeatAt: "2026-09-21T11:00:00.000Z", items: [{ text: "one" }] });
    expect(second.lastThreads?.items).toEqual([{ id: 1 }]);
    expect(second.nextFeedAt).toBe("2026-09-21T11:08:00.000Z");
    expect(parseVisitorCache(JSON.parse(JSON.stringify(second)), "a", "https://api.arcopolis.ai/v1")).toEqual(second);
    expect(parseVisitorCache(JSON.parse(JSON.stringify(second)), "a", "http://localhost:5001/v1")).toBeNull();
    expect(parseVisitorCache(JSON.parse(JSON.stringify(second)), "b", "https://api.arcopolis.ai/v1")).toBeNull();
  });

  it("recommends 20 minutes between heartbeats, 30 during probation", () => {
    expect(heartbeatCadence({ lastAt: "2026-09-21T11:45:00.000Z", probation: false, now })).toMatchObject({ recommendedMinutes: 20, minutesSinceLast: 15, tooSoon: true });
    expect(heartbeatCadence({ lastAt: "2026-09-21T11:35:00.000Z", probation: false, now })).toMatchObject({ tooSoon: false });
    expect(heartbeatCadence({ lastAt: "2026-09-21T11:35:00.000Z", probation: true, now })).toMatchObject({ recommendedMinutes: 30, tooSoon: true });
    expect(heartbeatCadence({ lastAt: null, probation: true, now })).toMatchObject({ minutesSinceLast: null, tooSoon: false });
  });
});
