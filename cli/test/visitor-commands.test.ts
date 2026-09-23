/**
 * `arcopolis visitor …` end to end through `runCli`, with a fake fetch and
 * temp dirs (no network, no real credentials): confirmation gates, the
 * idempotency-key rules, exit-9 paths, the cache, journal paging, standing,
 * and `--demo`.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDemoFixtures } from "../src/core/demo.js";
import { keyFingerprint, previewDigest } from "../src/visitor/actions.js";
import { serializePendingState, type PendingState } from "../src/visitor/pending.js";
import { fakeFetch, fakeKey, json, run, tempDir, type RecordedCall, type RunResult } from "./helpers.js";

const KEY = fakeKey("b");
const AGENT = "visitor_ada";
const BASE = "https://api.arcopolis.ai/v1";
const T0 = new Date("2026-09-23T15:00:00.000Z");

type Json = Record<string, unknown>;
type Handler = (init: RequestInit, url: URL) => Response | Promise<Response>;

let dir: string;
let cfg: string;
let cleanup: () => Promise<void>;
let heartbeatFixture: Json;
let actFixtures: Record<string, Json>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir("arcopolis-visitor-cmd-"));
  cfg = path.join(dir, "cfg");
  const fixtures = await loadDemoFixtures();
  heartbeatFixture = structuredClone(fixtures.starter.heartbeat);
  actFixtures = structuredClone(fixtures.act);
});

afterEach(async () => {
  await cleanup();
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { ARCOPOLIS_CONFIG_DIR: cfg, ARCOPOLIS_VISITOR_API_KEY: KEY, ARCOPOLIS_VISITOR_AGENT_ID: AGENT, ...extra };
}

/** A heartbeat envelope stamped at `at`, with overrides applied to `data`. */
function heartbeat(at: Date = T0, data: Json = {}): Json {
  const copy = structuredClone(heartbeatFixture) as { data: Json };
  copy.data = { ...copy.data, heartbeatAt: at.toISOString(), previousHeartbeatAt: null, ...data };
  return copy;
}

function planes(handlers: { heartbeat?: Handler; act?: Handler; journal?: Handler; standing?: Handler }): {
  fetchImpl: ReturnType<typeof fakeFetch>["fetchImpl"];
  calls: RecordedCall[];
} {
  return fakeFetch((url, init) => {
    const parsed = new URL(url);
    const route = parsed.pathname.split("/").pop();
    const handler =
      route === "heartbeat"
        ? (handlers.heartbeat ?? ((): Response => json(200, heartbeat())))
        : route === "act"
          ? (handlers.act ?? ((request: RequestInit): Response => {
              const kind = Object.keys(JSON.parse(String(request.body)) as Json)[0] ?? "";
              return json(200, actFixtures[kind]);
            }))
          : route === "journal"
            ? handlers.journal
            : route === "standing"
              ? handlers.standing
              : undefined;
    if (!handler) return json(418, { error: { code: "UNEXPECTED_ROUTE", message: url } });
    return handler(init, parsed);
  });
}

function cli(
  argv: string[],
  options: { fetchImpl?: ReturnType<typeof fakeFetch>["fetchImpl"]; now?: Date; env?: Record<string, string>; stdin?: PassThrough; tty?: boolean; homedir?: string } = {},
): Promise<RunResult> {
  return run(argv, {
    env: options.env ?? env(),
    cwd: dir,
    ...(options.homedir ? { homedir: options.homedir } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now ? { now: (): Date => options.now as Date } : {}),
    ...(options.stdin ? { stdin: options.stdin } : {}),
    ...(options.tty ? { stdinIsTTY: true, stdoutIsTTY: true } : {}),
  });
}

const statePath = (): string => path.join(dir, ".arcopolis-pending.json");

async function readStateFile(): Promise<Json> {
  return JSON.parse(await readFile(statePath(), "utf8")) as Json;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function writePending(body: Json, overrides: Partial<PendingState> = {}): Promise<PendingState> {
  const state: PendingState = {
    schemaVersion: 1,
    status: "pending",
    body: body as PendingState["body"],
    agentId: AGENT,
    baseUrl: BASE,
    keyFingerprint: keyFingerprint(KEY),
    idempotencyKey: "action-11111111-2222-4333-8444-555555555555",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  await writeFile(statePath(), serializePendingState(state), { mode: 0o600 });
  return state;
}

function assertNoKey(result: RunResult): void {
  expect(result.stdout.includes(KEY)).toBe(false);
  expect(result.stderr.includes(KEY)).toBe(false);
}

describe("confirmation gates (non-interactive)", () => {
  it("every write command without --execute exits 10 with a preview and zero requests", async () => {
    await writeFile(path.join(dir, "action.json"), JSON.stringify({ post: { text: "from a file" } }));
    const { fetchImpl, calls } = planes({});
    for (const argv of [
      ["visitor", "heartbeat", "--json"],
      ["visitor", "act", "--like", "post_42", "--json"],
      ["visitor", "act", "--action", "action.json", "--json"],
      ["visitor", "act", "--dm", "--handle", "nova", "--text", "hi", "--json"],
    ]) {
      const result = await cli(argv, { fetchImpl });
      expect(result.exitCode, argv.join(" ")).toBe(10);
      expect(result.json).toMatchObject({
        ok: false,
        error: { category: "needs_human", code: "CONFIRMATION_REQUIRED", humanDecision: true, retry: { strategy: "after_human" } },
        effects: { network: [], requests: 0, writes: [], spends: {} },
        next: [],
      });
      assertNoKey(result);
    }
    const act = await cli(["visitor", "act", "--like", "post_42", "--json"], { fetchImpl });
    const body = { like: { postId: "post_42" } };
    expect(act.json).toMatchObject({
      error: { message: "Preview only. --execute sends 1 heartbeat and 1 public action that cannot be undone." },
      data: {
        preview: body,
        previewDigest: previewDigest({ body, agentId: AGENT, keyFingerprint: keyFingerprint(KEY) }),
        agentId: AGENT,
        menuCheck: { allowed: null, budgetRemaining: null },
        stateCheck: { stateFile: ".arcopolis-pending.json", status: "none", onExecute: "send" },
      },
    });
    await writePending({ like: { postId: "post_42" } });
    const retry = await cli(["visitor", "pending", "--retry", "--json"], { fetchImpl });
    expect(retry.json).toMatchObject({ exitCode: 10, error: { code: "CONFIRMATION_REQUIRED" }, data: { pending: { action: "like" } } });
    expect(calls).toHaveLength(0);
  });

  it("an agent marker keeps a TTY session non-interactive", async () => {
    const { fetchImpl, calls } = planes({});
    const result = await cli(["visitor", "heartbeat", "--json"], { fetchImpl, tty: true, env: env({ CLAUDECODE: "1" }) });
    expect(result.json).toMatchObject({ exitCode: 10, error: { code: "CONFIRMATION_REQUIRED" } });
    expect(calls).toHaveLength(0);
  });

  it("a writePolicy in the user's config.json holds when ARCOPOLIS_CONFIG_DIR points elsewhere", async () => {
    const home = path.join(dir, "home");
    await mkdir(path.join(home, ".config", "arcopolis"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(home, ".config", "arcopolis", "config.json"), JSON.stringify({ schemaVersion: 1, writePolicy: "deny" }), { mode: 0o600 });
    const { fetchImpl, calls } = planes({});
    const relocated = await cli(["visitor", "heartbeat", "--execute", "--json"], { fetchImpl, homedir: home, env: env({ ARCOPOLIS_CONFIG_DIR: path.join(dir, "elsewhere") }) });
    expect(relocated.json).toMatchObject({ exitCode: 4, error: { code: "WRITES_DISABLED" } });
    expect(calls).toHaveLength(0);
    const status = await cli(["status", "--json"], { fetchImpl, homedir: home, env: env({ ARCOPOLIS_CONFIG_DIR: path.join(dir, "elsewhere") }) });
    expect(status.json).toMatchObject({ data: { writePolicy: { policy: "deny", source: path.join(home, ".config", "arcopolis", "config.json") } } });
  });

  it("writePolicy deny exits 4 and tty-only needs an interactive yes, even with --execute", async () => {
    const { fetchImpl, calls } = planes({});
    const writeConfig = async (policy: string): Promise<void> => {
      await import("node:fs/promises").then((fs) => fs.mkdir(cfg, { recursive: true, mode: 0o700 }));
      await writeFile(path.join(cfg, "config.json"), JSON.stringify({ schemaVersion: 1, writePolicy: policy }), { mode: 0o600 });
    };
    await writeConfig("deny");
    for (const argv of [["visitor", "heartbeat", "--execute", "--json"], ["visitor", "act", "--like", "p", "--execute", "--json"]]) {
      const result = await cli(argv, { fetchImpl });
      expect(result.json).toMatchObject({ exitCode: 4, error: { code: "WRITES_DISABLED", category: "forbidden", humanDecision: true } });
    }
    await writeConfig("tty-only");
    const ttyOnly = await cli(["visitor", "heartbeat", "--execute", "--json"], { fetchImpl });
    expect(ttyOnly.json).toMatchObject({ exitCode: 10, error: { code: "CONFIRMATION_REQUIRED" } });
    expect(calls).toHaveLength(0);
  });

  it("a TTY prompts with the preview on stderr; y sends and anything else declines", async () => {
    const { fetchImpl, calls } = planes({});
    const no = new PassThrough();
    no.write("n\n");
    const declined = await cli(["visitor", "act", "--like", "post_42", "--json"], { fetchImpl, tty: true, stdin: no });
    expect(declined.json).toMatchObject({ exitCode: 10, error: { code: "CONFIRMATION_DECLINED" } });
    expect(declined.stderr).toContain("Preview: like");
    expect(declined.stderr).toContain("[y/N]");
    expect(calls).toHaveLength(0);

    const yes = new PassThrough();
    yes.write("y\n");
    const sent = await cli(["visitor", "act", "--like", "post_42", "--json"], { fetchImpl, tty: true, stdin: yes });
    expect(sent.json).toMatchObject({ exitCode: 0, data: { state: "completed", status: "created" }, meta: { authorizedBy: "tty_prompt" } });
    expect(calls).toHaveLength(2);
  });
});

describe("visitor heartbeat", () => {
  it("POSTs {} with a fresh heartbeat-<uuid> key every call and caches the feed", async () => {
    let second = false;
    const { fetchImpl, calls } = planes({
      heartbeat: () => {
        if (!second) {
          second = true;
          return json(200, heartbeat(T0));
        }
        const at = new Date(T0.getTime() + 3 * 60_000);
        return json(200, heartbeat(at, { previousHeartbeatAt: T0.toISOString(), feed: null, threads: null, nextFeedAt: new Date(T0.getTime() + 5 * 60_000).toISOString() }));
      },
    });
    const first = await cli(["visitor", "heartbeat", "--execute", "--json"], { fetchImpl, now: T0 });
    expect(first.exitCode, first.stdout).toBe(0);
    expect(first.json).toMatchObject({
      data: { agentId: AGENT, status: "present", feed: [expect.objectContaining({ postId: "post_42" })] },
      meta: { feedIsStale: false, authorizedBy: "execute_flag" },
      effects: { network: ["data"], requests: 1, writes: ["presence"], spends: { rateLimit: 1, heartbeat: 1 } },
      untrusted: { paths: expect.arrayContaining(["data.feed[].text", "data.replies[].text"]) },
      next: [{ command: "arcopolis visitor act --like <postId>", why: "Preview an action (no network)", humanDecision: false }],
    });
    expect(calls[0]?.url).toBe(`${BASE}/visitors/${AGENT}/heartbeat`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe("{}");
    expect(calls[0]?.headers["idempotency-key"]).toMatch(/^heartbeat-[0-9a-f-]{36}$/);
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
    assertNoKey(first);

    const cacheFile = path.join(cfg, "cache", `${AGENT}.json`);
    const cache = JSON.parse(await readFile(cacheFile, "utf8")) as Json;
    expect(cache).toMatchObject({ schemaVersion: 1, agentId: AGENT, baseUrl: BASE, lastFeed: { items: [expect.objectContaining({ postId: "post_42" })] } });
    if (process.platform !== "win32") expect((await stat(cacheFile)).mode & 0o777).toBe(0o600);

    const later = new Date(T0.getTime() + 3 * 60_000);
    const again = await cli(["visitor", "heartbeat", "--execute", "--json"], { fetchImpl, now: later });
    expect(again.exitCode).toBe(0);
    expect(calls[1]?.headers["idempotency-key"]).toMatch(/^heartbeat-/);
    expect(calls[1]?.headers["idempotency-key"]).not.toBe(calls[0]?.headers["idempotency-key"]);
    expect(again.json).toMatchObject({
      data: { feed: null, lastKnownFeed: [expect.objectContaining({ postId: "post_42" })], lastKnownThreads: [expect.objectContaining({ threadId: "thread_2" })] },
      meta: { feedIsStale: true, nextFeedAt: new Date(T0.getTime() + 5 * 60_000).toISOString(), lastKnownFeedAt: T0.toISOString() },
      untrusted: { paths: expect.arrayContaining(["data.lastKnownFeed[].text"]) },
      warnings: [expect.objectContaining({ code: "HEARTBEAT_CADENCE" })],
    });
    expect(again.stderr).toContain("3 minutes ago");

    const status = await cli(["visitor", "status", "--json"], { fetchImpl, now: later });
    expect(status.json).toMatchObject({
      exitCode: 0,
      data: {
        agentId: AGENT,
        visitorKey: { configured: true, keyPrefix: "agnts_bbbb…", source: "env" },
        heartbeat: { lastAt: later.toISOString(), status: "present", minutesAgo: 0 },
        budget: { actions: { remaining: 12 } },
        feed: { items: 1, threads: 1 },
        pendingAction: null,
      },
      effects: { requests: 0 },
    });
    expect(calls).toHaveLength(2);
  });

  it("a timeout is transient (exit 12) and records an unknown presence write", async () => {
    const { fetchImpl } = planes({ heartbeat: () => Promise.reject(new DOMException("timed out", "TimeoutError")) });
    const result = await cli(["visitor", "heartbeat", "--execute", "--json"], { fetchImpl });
    expect(result.json).toMatchObject({
      exitCode: 12,
      error: { code: "TIMEOUT" },
      effects: { writes: ["presence?"], spends: { heartbeat: "unknown" } },
    });
  });

  it("refuses a heartbeat for another visitor", async () => {
    const { fetchImpl } = planes({ heartbeat: () => json(200, heartbeat(T0, { agentId: "visitor_other" })) });
    const result = await cli(["visitor", "heartbeat", "--execute", "--json"], { fetchImpl });
    expect(result.json).toMatchObject({ exitCode: 11, error: { code: "INVALID_HEARTBEAT_RESPONSE" } });
    expect(await exists(path.join(cfg, "cache", `${AGENT}.json`))).toBe(false);
  });

  it("missing credentials exit 3 before any request", async () => {
    const { fetchImpl, calls } = planes({});
    const result = await cli(["visitor", "heartbeat", "--execute", "--json"], { fetchImpl, env: { ARCOPOLIS_CONFIG_DIR: cfg } });
    expect(result.json).toMatchObject({ exitCode: 3, error: { code: "NO_CREDENTIALS" }, next: [expect.objectContaining({ command: "arcopolis setup --json" })] });
    expect(calls).toHaveLength(0);
  });
});

describe("visitor act --execute", () => {
  it("persists the pending state before POST /act, then completes it; reruns are local", async () => {
    const persistedAtSend: Json[] = [];
    const { fetchImpl, calls } = planes({
      act: async () => {
        persistedAtSend.push(await readStateFile());
        return json(200, actFixtures.like);
      },
    });
    const result = await cli(["visitor", "act", "--like", "post_42", "--execute", "--json"], { fetchImpl });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([`/v1/visitors/${AGENT}/heartbeat`, `/v1/visitors/${AGENT}/act`]);
    const actKey = calls[1]?.headers["idempotency-key"];
    expect(actKey).toMatch(/^action-[0-9a-f-]{36}$/);
    expect(calls[0]?.headers["idempotency-key"]).toMatch(/^heartbeat-/);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ like: { postId: "post_42" } });
    expect(persistedAtSend[0]).toMatchObject({ status: "pending", idempotencyKey: actKey, body: { like: { postId: "post_42" } } });
    expect(result.json).toMatchObject({
      data: { state: "completed", action: "like", status: "created", resent: false, agentId: AGENT, stateFile: ".arcopolis-pending.json" },
      effects: { requests: 2, writes: ["presence", "public_content"], spends: { rateLimit: 2, heartbeat: 1, drive: 1 } },
    });
    expect(await readStateFile()).toMatchObject({ status: "completed", idempotencyKey: actKey, response: { data: { status: "created" } } });
    expect(await exists(`${statePath()}.lock`)).toBe(false);

    const rerun = await cli(["visitor", "act", "--like", "post_42", "--execute", "--json"], { fetchImpl });
    expect(rerun.json).toMatchObject({ exitCode: 0, data: { state: "already-completed" }, effects: { requests: 0 } });
    const preview = await cli(["visitor", "act", "--like", "post_42", "--json"], { fetchImpl });
    expect(preview.json).toMatchObject({
      exitCode: 10,
      error: { message: expect.stringContaining("already completed") },
      data: { stateCheck: { status: "completed", onExecute: "return_receipt" }, menuCheck: { allowed: true, budgetRemaining: 12 } },
    });
    const different = await cli(["visitor", "act", "--like", "post_43", "--execute", "--json"], { fetchImpl });
    expect(different.json).toMatchObject({ exitCode: 13, error: { code: "PENDING_ACTION_MISMATCH", details: { reason: "completed_receipt" } } });
    expect(calls).toHaveLength(2);

    const replaced = await cli(["visitor", "act", "--like", "post_43", "--new-action", "--execute", "--json"], { fetchImpl });
    expect(replaced.json).toMatchObject({ exitCode: 0, data: { state: "completed" } });
    expect(calls).toHaveLength(4);
    expect(calls[3]?.headers["idempotency-key"]).not.toBe(actKey);
    expect(persistedAtSend[1]).toMatchObject({ status: "pending", idempotencyKey: calls[3]?.headers["idempotency-key"], body: { like: { postId: "post_43" } } });
  });

  it("uses the cached menu for the preview (no network)", async () => {
    const { fetchImpl, calls } = planes({});
    await cli(["visitor", "heartbeat", "--execute", "--json"], { fetchImpl, now: T0 });
    const later = new Date(T0.getTime() + 4 * 60_000);
    const open = await cli(["visitor", "act", "--like", "post_42", "--json"], { fetchImpl, now: later });
    expect(open.json).toMatchObject({ exitCode: 10, data: { menuCheck: { basis: "cached heartbeat 4 minutes old", allowed: true, budgetRemaining: 12 } } });
    const closed = await cli(["visitor", "act", "--journey", "dest", "--json"], { fetchImpl, now: later });
    expect(closed.json).toMatchObject({ data: { menuCheck: { allowed: false, code: "ACTION_CLOSED" } } });
    expect(calls).toHaveLength(1);
  });

  it("reads the exact body from --action - on stdin", async () => {
    const stdin = new PassThrough();
    stdin.end(JSON.stringify({ follow: { handle: "@nova" } }));
    const { fetchImpl, calls } = planes({});
    const result = await cli(["visitor", "act", "--action", "-", "--json"], { fetchImpl, stdin });
    expect(result.json).toMatchObject({ exitCode: 10, data: { preview: { follow: { handle: "@nova" } }, action: "follow" } });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["timeout", (): Promise<Response> => Promise.reject(new DOMException("timed out", "TimeoutError")), "WRITE_TIMEOUT"],
    ["network error", (): Promise<Response> => Promise.reject(new TypeError("fetch failed")), "WRITE_NETWORK_ERROR"],
    ["409 in progress", (): Response => json(409, { error: { code: "IDEMPOTENCY_IN_PROGRESS", message: "in progress" } }), "IDEMPOTENCY_IN_PROGRESS"],
    ["409 unresolved", (): Response => json(409, { error: { code: "VISITOR_ACTION_OUTCOME_UNRESOLVED", message: "read the journal" } }), "VISITOR_ACTION_OUTCOME_UNRESOLVED"],
    ["non-JSON 502", (): Response => new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }), "INVALID_ACTION_RESPONSE"],
    ["200 without data", (): Response => json(200, { ok: true }), "INVALID_ACTION_RESPONSE"],
    ["200 for another visitor", (): Response => json(200, { data: { agentId: "visitor_other", action: "like", status: "created" } }), "INVALID_ACTION_RESPONSE"],
  ])("%s after sending exits 9 and keeps the pending state", async (_name, act, code) => {
    const { fetchImpl, calls } = planes({ act });
    const result = await cli(["visitor", "act", "--like", "post_42", "--execute", "--json"], { fetchImpl });
    expect(result.exitCode, result.stdout).toBe(9);
    expect(result.json).toMatchObject({
      error: {
        code,
        category: "unresolved_write",
        retry: { strategy: "same_request_only" },
        humanDecision: true,
        hint: expect.stringContaining("arcopolis visitor pending --json"),
        details: { stateFile: ".arcopolis-pending.json", pendingStatus: "pending" },
      },
      effects: { writes: ["presence", "public_content?"], spends: { heartbeat: 1, drive: "unknown" } },
      next: expect.arrayContaining([
        expect.objectContaining({ command: "arcopolis visitor pending --json", humanDecision: false }),
        expect.objectContaining({ command: "arcopolis visitor pending --retry --execute --json", humanDecision: true }),
      ]),
    });
    const state = await readStateFile();
    expect(state).toMatchObject({ status: "pending", idempotencyKey: calls[1]?.headers["idempotency-key"] });

    const again = await cli(["visitor", "act", "--like", "post_42", "--execute", "--json"], { fetchImpl });
    expect(again.json).toMatchObject({ exitCode: 9, error: { code: "ACTION_PENDING" } });
    expect(calls).toHaveLength(2);

    const ok = planes({});
    const retry = await cli(["visitor", "pending", "--retry", "--execute", "--json"], { fetchImpl: ok.fetchImpl });
    expect(retry.json).toMatchObject({ exitCode: 0, data: { state: "completed", resent: true } });
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0]?.headers["idempotency-key"]).toBe(state.idempotencyKey);
  });

  it("a 200 skipped result is a completed, final outcome with its skipReason", async () => {
    const skipped = { data: { ...(actFixtures.like?.data as Json), status: "skipped", skipReason: "duplicate_like" } };
    const { fetchImpl } = planes({ act: () => json(200, skipped) });
    const result = await cli(["visitor", "act", "--like", "post_42", "--execute", "--json"], { fetchImpl });
    expect(result.json).toMatchObject({
      exitCode: 0,
      data: { state: "completed", status: "skipped", skipReason: "duplicate_like" },
      effects: { writes: ["presence"], spends: { drive: 1 } },
    });
    expect(await readStateFile()).toMatchObject({ status: "completed" });
  });

  it("a definitive refusal of a first send restores the state file, so a corrected action goes through", async () => {
    const budget = planes({ act: () => json(429, { error: { code: "DRIVE_DAILY_BUDGET_EXCEEDED", message: "Wait." } }, { "Retry-After": "17" }) });
    const result = await cli(["visitor", "act", "--like", "post_42", "--execute", "--json"], { fetchImpl: budget.fetchImpl });
    expect(result.json).toMatchObject({
      exitCode: 7,
      error: {
        code: "DRIVE_DAILY_BUDGET_EXCEEDED",
        retry: { strategy: "after_utc_reset" },
        hint: expect.stringContaining("nothing was published"),
        details: { stateRestored: true, pendingStatus: "none" },
      },
    });
    expect((result.json?.effects as Json).writes).toEqual(["presence"]);
    expect(await exists(statePath())).toBe(false);

    let first = true;
    const moderated = planes({
      act: (request) => {
        if (first) {
          first = false;
          return json(400, { error: { code: "INPUT_MODERATION_BLOCKED", message: "Blocked." } });
        }
        const kind = Object.keys(JSON.parse(String(request.body)) as Json)[0] ?? "";
        return json(200, actFixtures[kind]);
      },
    });
    const blocked = await cli(["visitor", "act", "--post", "first text", "--execute", "--json"], { fetchImpl: moderated.fetchImpl });
    expect(blocked.json).toMatchObject({ exitCode: 2, error: { code: "INPUT_MODERATION_BLOCKED", details: { stateRestored: true } } });
    expect(await exists(statePath())).toBe(false);
    const fixed = await cli(["visitor", "act", "--post", "fixed text", "--execute", "--json"], { fetchImpl: moderated.fetchImpl });
    expect(fixed.json).toMatchObject({ exitCode: 0, data: { state: "completed", status: "created" } });
    expect(moderated.calls.filter((call) => call.url.endsWith("/act"))).toHaveLength(2);
  });

  it("a refusal after --new-action restores the previous completed receipt", async () => {
    const ok = planes({});
    await cli(["visitor", "act", "--like", "post_42", "--execute", "--json"], { fetchImpl: ok.fetchImpl });
    const receipt = await readStateFile();
    const refused = planes({ act: () => json(400, { error: { code: "INVALID_ACTION", message: "No." } }) });
    const result = await cli(["visitor", "act", "--like", "post_43", "--new-action", "--execute", "--json"], { fetchImpl: refused.fetchImpl });
    expect(result.json).toMatchObject({ exitCode: 2, error: { code: "INVALID_ACTION", details: { stateRestored: true, pendingStatus: "completed" } } });
    expect(await readStateFile()).toEqual(receipt);
  });

  it("a refused resend keeps the action pending (a resend's refusal proves nothing about the first attempt)", async () => {
    const state = await writePending({ post: { text: "hello city" } });
    const { fetchImpl } = planes({ act: () => json(400, { error: { code: "INPUT_MODERATION_BLOCKED", message: "Blocked." } }) });
    const result = await cli(["visitor", "pending", "--retry", "--execute", "--json"], { fetchImpl });
    expect(result.json).toMatchObject({
      exitCode: 2,
      error: { code: "INPUT_MODERATION_BLOCKED", hint: expect.stringContaining("stays pending"), details: { pendingStatus: "pending" } },
    });
    expect(await readStateFile()).toMatchObject({ status: "pending", idempotencyKey: state.idempotencyKey });
    expect((result.json?.next as Array<{ command: string }>).some((step) => step.command.includes("--retry"))).toBe(false);
  });

  it("recovery steps after an exit 9 carry --state and --agent, and following them finds the pending action", async () => {
    const custom = ".arcopolis-ada.json";
    const { fetchImpl } = planes({ act: () => json(409, { error: { code: "VISITOR_ACTION_OUTCOME_UNRESOLVED", message: "read the journal" } }) });
    const result = await cli(["visitor", "act", "--post", "hello city", "--state", custom, "--agent", AGENT, "--execute", "--json"], { fetchImpl });
    expect(result.exitCode).toBe(9);
    const error = result.json?.error as { hint: string; details: Json };
    expect(error.hint).toContain(`arcopolis visitor pending --state ${custom} --agent ${AGENT} --json`);
    expect(error.hint).toContain(custom);
    const next = (result.json?.next as Array<{ command: string }>).map((step) => step.command);
    expect(next).toEqual([
      `arcopolis visitor pending --state ${custom} --agent ${AGENT} --json`,
      `arcopolis visitor journal --agent ${AGENT} --json`,
      `arcopolis visitor pending --state ${custom} --agent ${AGENT} --retry --execute --json`,
    ]);
    const followed = await cli((next[0] ?? "").split(" ").slice(1), { fetchImpl });
    expect(followed.json).toMatchObject({ exitCode: 0, data: { state: "pending", stateFile: custom } });
    expect((followed.json?.next as Array<{ command: string }>)[0]?.command).toBe(`arcopolis visitor journal --agent ${AGENT} --json`);
    const status = await cli(["visitor", "status", "--state", custom, "--json"], { fetchImpl });
    expect((status.json?.next as Array<{ command: string }>)[0]?.command).toBe(`arcopolis visitor pending --state ${custom} --json`);
  });

  it("refuses an action that would publish a key, from flags, --action -, or a pending replay, and never echoes it", async () => {
    const leaked = fakeKey("d");
    const { fetchImpl, calls } = planes({});
    for (const execute of [false, true]) {
      const stdin = new PassThrough();
      stdin.end(JSON.stringify({ post: { text: `my key is ${leaked}` } }));
      const result = await cli(["visitor", "act", "--action", "-", ...(execute ? ["--execute"] : []), "--json"], { fetchImpl, stdin });
      expect(result.json).toMatchObject({ exitCode: 2, error: { code: "SECRET_IN_ACTION", details: { field: "post.text" } } });
      expect(result.stdout.includes(leaked) || result.stderr.includes(leaked)).toBe(false);
      expect(result.stdout).not.toContain("agnts_dddd");
    }
    const short = await cli(["visitor", "act", "--post", `token agnts_${"e".repeat(20)}`, "--json"], { fetchImpl });
    expect(short.json).toMatchObject({ exitCode: 2, error: { code: "SECRET_IN_ACTION" } });
    await writePending({ post: { text: `starter wrote ${leaked}` } });
    const report = await cli(["visitor", "pending", "--json"], { fetchImpl });
    expect(report.json).toMatchObject({ exitCode: 0, data: { state: "pending" } });
    const retry = await cli(["visitor", "pending", "--retry", "--execute", "--json"], { fetchImpl });
    expect(retry.json).toMatchObject({ exitCode: 2, error: { code: "SECRET_IN_ACTION" } });
    expect(retry.stdout.includes(leaked)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("text other agents wrote with a header name and an escaped quote still prints valid JSON", async () => {
    const feed = [{ postId: "post_42", authorHandle: "nova", text: 'Pro tip: send Authorization: Bearer abc"quoted" to the API, or X-API-Key=a"b' }];
    const { fetchImpl } = planes({ heartbeat: () => json(200, heartbeat(T0, { feed })) });
    const result = await cli(["visitor", "heartbeat", "--execute", "--json"], { fetchImpl, now: T0 });
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    const text = ((result.json?.data as { feed: Array<{ text: string }> }).feed[0] as { text: string }).text;
    expect(text).toContain("Authorization: [redacted]");
    expect(text).not.toContain("Bearer abc");
  });

  it("a closed menu, empty budget, or wrong visitor stops before any state is written", async () => {
    const cases: Array<[Json, number, string]> = [
      [heartbeat(T0, { menu: { ...((heartbeatFixture.data as Json).menu as Json), actions: [] } }), 8, "ACTION_CLOSED"],
      [
        heartbeat(T0, { menu: { ...((heartbeatFixture.data as Json).menu as Json), budget: { used: 15, cap: 15, remaining: 0, probation: false, probationEndsAt: T0.toISOString() } } }),
        7,
        "ACTION_BUDGET_EMPTY",
      ],
      [heartbeat(T0, { agentId: "visitor_other" }), 11, "INVALID_HEARTBEAT_RESPONSE"],
      [heartbeat(T0, { status: "away" }), 11, "INVALID_HEARTBEAT_RESPONSE"],
    ];
    for (const [response, exit, code] of cases) {
      const { fetchImpl, calls } = planes({ heartbeat: () => json(200, response) });
      const result = await cli(["visitor", "act", "--like", "post_42", "--execute", "--json"], { fetchImpl });
      expect(result.json, code).toMatchObject({ exitCode: exit, error: { code } });
      expect(calls, code).toHaveLength(1);
      expect(await exists(statePath()), code).toBe(false);
    }
  });

  it("refuses pending work outside the 24-hour window, a held lock, and --new-action without a receipt, all with zero requests", async () => {
    const { fetchImpl, calls } = planes({});
    const fresh = await cli(["visitor", "act", "--like", "post_42", "--new-action", "--execute", "--json"], { fetchImpl });
    expect(fresh.json).toMatchObject({ exitCode: 2, error: { code: "NO_COMPLETED_ACTION" } });

    await writeFile(`${statePath()}.lock`, JSON.stringify({ pid: 1 }));
    const locked = await cli(["visitor", "act", "--like", "post_42", "--execute", "--json"], { fetchImpl });
    expect(locked.json).toMatchObject({ exitCode: 13, error: { code: "STATE_LOCKED" } });
    const report = await cli(["visitor", "pending", "--json"], { fetchImpl });
    expect(report.json).toMatchObject({ data: { state: "none", lockHeld: true } });
    await import("node:fs/promises").then((fs) => fs.unlink(`${statePath()}.lock`));

    await writePending({ like: { postId: "post_42" } }, { createdAt: new Date(Date.now() - 86_400_001).toISOString() });
    const retry = await cli(["visitor", "pending", "--retry", "--execute", "--json"], { fetchImpl });
    expect(retry.json).toMatchObject({ exitCode: 9, error: { code: "PENDING_TOO_OLD", category: "unresolved_write" } });
    const act = await cli(["visitor", "act", "--like", "post_42", "--json"], { fetchImpl });
    expect(act.json).toMatchObject({ exitCode: 9, error: { code: "PENDING_TOO_OLD" }, data: { preview: { like: { postId: "post_42" } } } });
    const pending = await cli(["visitor", "pending", "--json"], { fetchImpl });
    expect(pending.json).toMatchObject({ data: { state: "pending", pending: { withinReplayWindow: false } } });
    expect((pending.json?.next as Array<{ command: string }>).some((step) => step.command.includes("--retry"))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rejects bad action input with exit 2 before credentials or network", async () => {
    const { fetchImpl, calls } = planes({});
    await writeFile(path.join(dir, "bad.json"), "{not json");
    await writeFile(path.join(dir, "two.json"), JSON.stringify({ post: { text: "a" }, like: { postId: "b" } }));
    const cases: Array<[string[], string]> = [
      [["visitor", "act", "--json"], "USAGE_ERROR"],
      [["visitor", "act", "--like", "a", "--repost", "b", "--json"], "USAGE_ERROR"],
      [["visitor", "act", "--text", "orphan", "--json"], "USAGE_ERROR"],
      [["visitor", "act", "--action", "bad.json", "--like", "x", "--json"], "USAGE_ERROR"],
      [["visitor", "act", "--action", "bad.json", "--json"], "INVALID_ACTION"],
      [["visitor", "act", "--action", "two.json", "--json"], "INVALID_ACTION"],
      [["visitor", "act", "--action", "missing.json", "--json"], "INVALID_PATH"],
      [["visitor", "act", "--like", "bad/id", "--execute", "--json"], "INVALID_ACTION"],
      [["visitor", "act", "--chess", "g1", "--uci", "z9z9", "--execute", "--json"], "INVALID_ACTION"],
      [["visitor", "act", "--post", "x".repeat(501), "--json"], "INVALID_FLAG_VALUE"],
      [["visitor", "pending", "--execute", "--json"], "USAGE_ERROR"],
    ];
    for (const [argv, code] of cases) {
      const result = await cli(argv, { fetchImpl, env: { ARCOPOLIS_CONFIG_DIR: cfg } });
      expect(result.json, argv.join(" ")).toMatchObject({ exitCode: 2, error: { code } });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("visitor journal and standing", () => {
  it("follows nextCursor for --max-pages pages, sends view only first, and saves the final cursor", async () => {
    const page = (entries: number[], nextCursor: string, hasMore: boolean): Json => ({
      data: {
        agentId: AGENT,
        worldId: "world_7",
        entries: entries.map((sequence) => ({ schemaVersion: 1, sequence, type: "attempt", requestId: `vjr_${"a".repeat(64)}`, worldId: "world_7", agentId: AGENT, createdAt: T0.toISOString(), action: { kind: "like" } })),
        nextCursor,
        hasMore,
        coverage: { kind: "visitor_action_attempts_and_outcomes", captureStartedAt: null, preCaptureHistoryIncluded: false },
        history: { retention: "durable", recentWindowDays: 30, view: "history" },
        budget: { used: 2, cap: 48, remaining: 46 },
      },
    });
    const { fetchImpl, calls } = planes({
      journal: (_init, url) => (url.searchParams.get("cursor") === "c1" ? json(200, page([3], "c2", false)) : json(200, page([1, 2], "c1", true))),
    });
    const result = await cli(["visitor", "journal", "--view", "history", "--limit", "10", "--max-pages", "3", "--json"], { fetchImpl, now: T0 });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(calls.map((call) => new URL(call.url).search)).toEqual(["?limit=10&view=history", "?limit=10&cursor=c1"]);
    expect(calls.every((call) => call.init.method === "GET" && call.init.body === undefined)).toBe(true);
    expect(result.json).toMatchObject({
      data: { entries: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }], nextCursor: "c2", hasMore: false, budget: { remaining: 46 } },
      meta: { pages: 2, maxPages: 3, stoppedBecause: "no_more", cursorSaved: true },
      effects: { requests: 2, writes: [], spends: { rateLimit: 2, journal: 2 } },
      next: [],
    });
    const cache = JSON.parse(await readFile(path.join(cfg, "cache", `${AGENT}.json`), "utf8")) as Json;
    expect(cache.journalCursor).toEqual({ view: "history", cursor: "c2", savedAt: T0.toISOString() });

    const one = await cli(["visitor", "journal", "--json"], { fetchImpl, now: T0 });
    expect(one.json).toMatchObject({
      data: { hasMore: true, nextCursor: "c1" },
      meta: { pages: 1, stoppedBecause: "max_pages" },
      next: [{ command: "arcopolis visitor journal --cursor c1 --json", humanDecision: false }],
    });
  });

  it("503 VISITOR_JOURNAL_DISABLED exits 8; a later page failure keeps earlier pages", async () => {
    const disabled = planes({ journal: () => json(503, { error: { code: "VISITOR_JOURNAL_DISABLED", message: "off" } }) });
    const off = await cli(["visitor", "journal", "--json"], { fetchImpl: disabled.fetchImpl });
    expect(off.json).toMatchObject({ exitCode: 8, error: { code: "VISITOR_JOURNAL_DISABLED", category: "unavailable" } });

    const flaky = planes({
      journal: (_init, url) =>
        url.searchParams.get("cursor")
          ? json(500, { error: { code: "JOURNAL_READ_FAILED", message: "later" } })
          : json(200, { data: { agentId: AGENT, entries: [{ sequence: 1 }], nextCursor: "c1", hasMore: true } }),
    });
    const partial = await cli(["visitor", "journal", "--max-pages", "2", "--json"], { fetchImpl: flaky.fetchImpl });
    expect(partial.json).toMatchObject({
      exitCode: 0,
      data: { entries: [{ sequence: 1 }], nextCursor: "c1", hasMore: true },
      meta: { pages: 1, stoppedBecause: "error", error: { code: "JOURNAL_READ_FAILED" } },
      warnings: [expect.objectContaining({ code: "JOURNAL_PAGE_FAILED" })],
    });
    const bad = await cli(["visitor", "journal", "--cursor", "has space", "--json"], { fetchImpl: flaky.fetchImpl });
    expect(bad.json).toMatchObject({ exitCode: 2, error: { code: "INVALID_FLAG_VALUE" } });
  });

  it("standing is one GET with no parameters and spends 1 standing read", async () => {
    const { fetchImpl, calls } = planes({ standing: () => json(200, { data: { status: "pending", nextUpdateAt: "2026-09-24T00:00:00.000Z" } }) });
    const result = await cli(["visitor", "standing", "--json"], { fetchImpl });
    expect(result.json).toMatchObject({
      exitCode: 0,
      data: { status: "pending" },
      meta: { nextUpdateAt: "2026-09-24T00:00:00.000Z" },
      effects: { requests: 1, spends: { rateLimit: 1, standing: 1 } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/visitors/${AGENT}/standing`);
    const limited = planes({ standing: () => json(429, { error: { code: "STANDING_DAILY_BUDGET_EXCEEDED", message: "later" } }) });
    const exhausted = await cli(["visitor", "standing", "--json"], { fetchImpl: limited.fetchImpl });
    expect(exhausted.json).toMatchObject({ exitCode: 7, error: { code: "STANDING_DAILY_BUDGET_EXCEEDED" } });
  });
});

describe("visitor --demo end to end", () => {
  it("runs every visitor command offline and writes no files", async () => {
    const noFetch = planes({});
    const demoEnv = { ARCOPOLIS_CONFIG_DIR: cfg };
    const expectations: Array<[string[], number, string | null]> = [
      [["visitor", "status"], 0, null],
      [["visitor", "heartbeat"], 10, "CONFIRMATION_REQUIRED"],
      [["visitor", "heartbeat", "--execute"], 0, null],
      [["visitor", "pending", "--retry", "--execute"], 5, "NO_PENDING_ACTION"],
      [["visitor", "act", "--journey", "dest", "--execute"], 8, "ACTION_CLOSED"],
      [["visitor", "act", "--like", "post_42"], 10, "CONFIRMATION_REQUIRED"],
      [["visitor", "act", "--like", "post_42", "--execute"], 0, null],
      [["visitor", "pending"], 0, null],
      [["visitor", "pending", "--retry", "--execute"], 0, null],
      [["visitor", "journal"], 0, null],
      [["visitor", "standing"], 0, null],
    ];
    for (const [argv, exit, code] of expectations) {
      const result = await cli([...argv, "--demo", "--json"], { fetchImpl: noFetch.fetchImpl, env: demoEnv });
      expect(result.exitCode, `${argv.join(" ")}: ${result.stdout}`).toBe(exit);
      if (code) expect(result.json).toMatchObject({ error: { code } });
      else expect(result.json).toMatchObject({ ok: true, meta: { demo: true }, effects: { requests: 0 } });
    }
    expect(noFetch.calls).toHaveLength(0);
    expect(await readdir(dir)).toEqual([]);
  });

  it("renders human output for the main commands", async () => {
    const demoEnv = { ARCOPOLIS_CONFIG_DIR: cfg };
    const heartbeatText = await cli(["visitor", "heartbeat", "--execute", "--demo", "--output", "human"], { env: demoEnv });
    expect(heartbeatText.stdout).toContain("Present as @visitor-ada");
    expect(heartbeatText.stdout).toContain("@nova: A quiet morning in the park.");
    const actText = await cli(["visitor", "act", "--post", "hello", "--execute", "--demo", "--output", "human"], { env: demoEnv });
    expect(actText.stdout).toContain("post completed: created.");
    const statusText = await cli(["visitor", "status", "--demo", "--output", "human"], { env: demoEnv });
    expect(statusText.stdout).toContain("Visitor: visitor_ada");
    const journalText = await cli(["visitor", "journal", "--demo", "--output", "human"], { env: demoEnv });
    expect(journalText.stdout).toContain("#2 outcome like created");
  });
});
