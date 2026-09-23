/**
 * Two-way interop with the starter (plan §4.6, §8): the CLI writes a state
 * file that the starter's `executeAction` accepts and resumes, and the CLI
 * resumes a pending action the starter wrote. Imports
 * `examples/arcopolis-starter/node/actions.mjs` directly.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeFetch, fakeKey, json, run, tempDir } from "./helpers.js";

interface StarterRequest {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
}
interface StarterClient {
  apiKey: string;
  baseUrl: string;
  request: (route: string, init: StarterRequest) => Promise<unknown>;
}
interface StarterActions {
  executeAction(input: { client: StarterClient; agentId: string; body: unknown; statePath: string; newAction?: boolean }): Promise<{ state: string; result: unknown }>;
}
interface StarterClientModule {
  ApiError: new (status: number, code: string, message: string) => Error;
  DEFAULT_BASE: string;
}

const STARTER = new URL("../../examples/arcopolis-starter/node/", import.meta.url);
const KEY = fakeKey("b");
const AGENT = "visitor_ada";
const BODY = { like: { postId: "post_42", replyId: "reply_9" } };
const PENDING_KEYS = ["schemaVersion", "status", "body", "agentId", "baseUrl", "keyFingerprint", "idempotencyKey", "createdAt"];

let starter: StarterActions;
let starterClient: StarterClientModule;
let fixtures: { heartbeat: Record<string, unknown>; act: Record<string, unknown> };
let dir: string;
let cleanup: () => Promise<void>;
let statePath: string;

beforeAll(async () => {
  starter = (await import(new URL("actions.mjs", STARTER).href)) as StarterActions;
  starterClient = (await import(new URL("client.mjs", STARTER).href)) as StarterClientModule;
  fixtures = JSON.parse(await readFile(new URL("fixtures.json", STARTER), "utf8")) as typeof fixtures;
});

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir("arcopolis-visitor-interop-"));
  statePath = path.join(dir, ".arcopolis-pending.json");
});

afterEach(async () => {
  await cleanup();
});

function env(): Record<string, string> {
  return { ARCOPOLIS_CONFIG_DIR: path.join(dir, "cfg"), ARCOPOLIS_VISITOR_API_KEY: KEY, ARCOPOLIS_VISITOR_AGENT_ID: AGENT };
}

function starterFake(request: StarterClient["request"]): StarterClient {
  return { apiKey: KEY, baseUrl: starterClient.DEFAULT_BASE, request };
}

async function readState(): Promise<{ text: string; value: Record<string, unknown> }> {
  const text = await readFile(statePath, "utf8");
  return { text, value: JSON.parse(text) as Record<string, unknown> };
}

describe("CLI state file → starter", () => {
  it("the starter resumes a pending action the CLI persisted, with the same key and body", async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url.endsWith("/heartbeat")) return json(200, fixtures.heartbeat);
      throw new TypeError("fetch failed");
    });
    const cli = await run(["visitor", "act", "--like", "post_42", "--reply-id", "reply_9", "--execute", "--json"], { env: env(), cwd: dir, fetchImpl });
    expect(cli.exitCode, cli.stdout).toBe(9);
    expect(cli.json).toMatchObject({ error: { code: "WRITE_NETWORK_ERROR", category: "unresolved_write", retry: { strategy: "same_request_only" } } });
    expect(calls).toHaveLength(2);

    const { text, value } = await readState();
    expect(Object.keys(value)).toEqual(PENDING_KEYS);
    expect(text).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(value).toMatchObject({
      schemaVersion: 1,
      status: "pending",
      body: BODY,
      agentId: AGENT,
      baseUrl: starterClient.DEFAULT_BASE,
      keyFingerprint: createHash("sha256").update(KEY).digest("hex"),
    });
    expect(text.includes(KEY)).toBe(false);
    if (process.platform !== "win32") expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect(calls[1]?.headers["idempotency-key"]).toBe(value.idempotencyKey);

    const requests: Array<{ route: string } & StarterRequest> = [];
    const resumed = await starter.executeAction({
      client: starterFake(async (route, init) => {
        requests.push({ route, ...init });
        return structuredClone(fixtures.act);
      }),
      agentId: AGENT,
      body: BODY,
      statePath,
    });
    expect(resumed.state).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ route: `/visitors/${AGENT}/act`, method: "POST", idempotencyKey: value.idempotencyKey, body: BODY });

    const after = await run(["visitor", "pending", "--json"], { env: env(), cwd: dir, fetchImpl });
    expect(after.json).toMatchObject({ exitCode: 0, data: { state: "completed", pending: { outcome: "created", idempotencyKey: value.idempotencyKey } } });
    const again = await run(["visitor", "act", "--like", "post_42", "--reply-id", "reply_9", "--execute", "--json"], { env: env(), cwd: dir, fetchImpl });
    expect(again.json).toMatchObject({ exitCode: 0, data: { state: "already-completed", status: "created" } });
    expect(calls).toHaveLength(2);
  });

  it("the starter returns a receipt the CLI completed without sending anything", async () => {
    const { fetchImpl } = fakeFetch((url) => json(200, url.endsWith("/heartbeat") ? fixtures.heartbeat : fixtures.act));
    const cli = await run(["visitor", "act", "--like", "post_42", "--reply-id", "reply_9", "--execute", "--json"], { env: env(), cwd: dir, fetchImpl });
    expect(cli.exitCode, cli.stdout).toBe(0);
    const { text, value } = await readState();
    expect(Object.keys(value)).toEqual([...PENDING_KEYS, "response", "completedAt"]);
    expect(text).toBe(`${JSON.stringify(value, null, 2)}\n`);
    let sent = 0;
    const receipt = await starter.executeAction({
      client: starterFake(async () => {
        sent += 1;
        return {};
      }),
      agentId: AGENT,
      body: BODY,
      statePath,
    });
    expect(receipt.state).toBe("already-completed");
    expect(sent).toBe(0);
  });
});

describe("starter state file → CLI", () => {
  async function starterLeavesPending(): Promise<Record<string, unknown>> {
    const client = starterFake(async (route) => {
      if (route.endsWith("/heartbeat")) return structuredClone(fixtures.heartbeat);
      throw new starterClient.ApiError(0, "TIMEOUT", "uncertain");
    });
    await expect(starter.executeAction({ client, agentId: AGENT, body: BODY, statePath })).rejects.toMatchObject({ code: "TIMEOUT" });
    return (await readState()).value;
  }

  it("visitor pending --retry --execute resends the starter's pending action with its key and no heartbeat", async () => {
    const state = await starterLeavesPending();
    const { fetchImpl, calls } = fakeFetch(() => json(200, fixtures.act));

    const report = await run(["visitor", "pending", "--json"], { env: env(), cwd: dir, fetchImpl });
    expect(report.json).toMatchObject({
      exitCode: 0,
      data: {
        state: "pending",
        pending: { action: "like", body: BODY, idempotencyKey: state.idempotencyKey, withinReplayWindow: true },
        credentialsMatch: { agentId: true, baseUrl: true, key: true },
        lockHeld: false,
      },
      next: expect.arrayContaining([expect.objectContaining({ command: "arcopolis visitor pending --retry --execute --json", humanDecision: true })]),
    });

    const preview = await run(["visitor", "pending", "--retry", "--json"], { env: env(), cwd: dir, fetchImpl });
    expect(preview.json).toMatchObject({ exitCode: 10, error: { code: "CONFIRMATION_REQUIRED", humanDecision: true } });

    const sameAct = await run(["visitor", "act", "--like", "post_42", "--reply-id", "reply_9", "--execute", "--json"], { env: env(), cwd: dir, fetchImpl });
    expect(sameAct.json).toMatchObject({ exitCode: 9, error: { code: "ACTION_PENDING" } });
    const otherAct = await run(["visitor", "act", "--post", "different", "--execute", "--json"], { env: env(), cwd: dir, fetchImpl });
    expect(otherAct.json).toMatchObject({ exitCode: 13, error: { code: "PENDING_ACTION_MISMATCH" } });
    expect(calls).toHaveLength(0);

    const retry = await run(["visitor", "pending", "--retry", "--execute", "--json"], { env: env(), cwd: dir, fetchImpl });
    expect(retry.exitCode, retry.stdout).toBe(0);
    expect(retry.json).toMatchObject({ data: { state: "completed", resent: true, status: "created", action: "like" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${starterClient.DEFAULT_BASE}/visitors/${AGENT}/act`);
    expect(calls[0]?.headers["idempotency-key"]).toBe(state.idempotencyKey);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(BODY);

    const { text, value } = await readState();
    expect(Object.keys(value)).toEqual([...PENDING_KEYS, "response", "completedAt"]);
    expect(text).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(value.idempotencyKey).toBe(state.idempotencyKey);

    let sent = 0;
    const receipt = await starter.executeAction({
      client: starterFake(async () => {
        sent += 1;
        return {};
      }),
      agentId: AGENT,
      body: BODY,
      statePath,
    });
    expect(receipt.state).toBe("already-completed");
    expect(sent).toBe(0);
  });

  it("a different key cannot resume the starter's pending action", async () => {
    await starterLeavesPending();
    const { fetchImpl, calls } = fakeFetch(() => json(200, fixtures.act));
    const retry = await run(["visitor", "pending", "--retry", "--execute", "--json"], {
      env: { ...env(), ARCOPOLIS_VISITOR_API_KEY: fakeKey("c") },
      cwd: dir,
      fetchImpl,
    });
    expect(retry.json).toMatchObject({ exitCode: 13, error: { code: "PENDING_ACTION_MISMATCH", details: { fields: ["keyFingerprint"] } } });
    expect(calls).toHaveLength(0);
    expect((await readState()).value.status).toBe("pending");
  });
});

describe("from a subdirectory of a git repository (the starter's cwd-relative default)", () => {
  let sub: string;
  let subState: string;

  beforeEach(async () => {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    await writeFile(path.join(dir, ".gitignore"), "cfg/\n.arcopolis-*\n");
    sub = path.join(dir, "agent");
    await mkdir(sub);
    subState = path.join(sub, ".arcopolis-pending.json");
  });

  it("the CLI sees the starter's pending action in cwd and never sends a second key", async () => {
    const client = starterFake(async (route) => {
      if (route.endsWith("/heartbeat")) return structuredClone(fixtures.heartbeat);
      throw new starterClient.ApiError(409, "VISITOR_ACTION_OUTCOME_UNRESOLVED", "uncertain");
    });
    await expect(starter.executeAction({ client, agentId: AGENT, body: BODY, statePath: subState })).rejects.toMatchObject({
      code: "VISITOR_ACTION_OUTCOME_UNRESOLVED",
    });
    const { fetchImpl, calls } = fakeFetch(() => json(200, fixtures.act));
    const report = await run(["visitor", "pending", "--json"], { env: env(), cwd: sub, fetchImpl });
    expect(report.json).toMatchObject({ exitCode: 0, data: { state: "pending", stateFile: ".arcopolis-pending.json" } });
    const again = await run(["visitor", "act", "--like", "post_42", "--reply-id", "reply_9", "--execute", "--json"], { env: env(), cwd: sub, fetchImpl });
    expect(again.json).toMatchObject({ exitCode: 9, error: { code: "ACTION_PENDING" } });
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(dir, ".arcopolis-pending.json"))).toBe(false);
  });

  it("the starter resumes a pending action the CLI persisted in cwd", async () => {
    const { fetchImpl } = fakeFetch((url) => {
      if (url.endsWith("/heartbeat")) return json(200, fixtures.heartbeat);
      throw new TypeError("fetch failed");
    });
    const cli = await run(["visitor", "act", "--like", "post_42", "--reply-id", "reply_9", "--execute", "--json"], { env: env(), cwd: sub, fetchImpl });
    expect(cli.exitCode, cli.stdout).toBe(9);
    const saved = JSON.parse(await readFile(subState, "utf8")) as Record<string, unknown>;
    const requests: StarterRequest[] = [];
    const resumed = await starter.executeAction({
      client: starterFake(async (_route, init) => {
        requests.push(init);
        return structuredClone(fixtures.act);
      }),
      agentId: AGENT,
      body: BODY,
      statePath: subState,
    });
    expect(resumed.state).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.idempotencyKey).toBe(saved.idempotencyKey);
  });

  it("an arcopolis.json stateFile that would split from a starter file in cwd is refused, naming both files", async () => {
    await writeFile(path.join(dir, "arcopolis.json"), JSON.stringify({ schemaVersion: 1, stateFile: ".arcopolis-ada.json" }));
    await writeFile(subState, "{}\n");
    const { fetchImpl, calls } = fakeFetch(() => json(200, fixtures.act));
    const act = await run(["visitor", "act", "--like", "post_42", "--execute", "--json"], { env: env(), cwd: sub, fetchImpl });
    expect(act.json).toMatchObject({
      exitCode: 13,
      error: { code: "STATE_FILE_CONFLICT", details: { stateFile: path.join(dir, ".arcopolis-ada.json"), otherStateFile: ".arcopolis-pending.json" } },
    });
    expect(calls).toHaveLength(0);
    const status = await run(["status", "--json"], { env: env(), cwd: sub, fetchImpl });
    expect(status.json).toMatchObject({ exitCode: 0, warnings: expect.arrayContaining([expect.objectContaining({ code: "STATE_FILE_CONFLICT" })]) });
    const explicit = await run(["visitor", "pending", "--state", ".arcopolis-pending.json", "--json"], { env: env(), cwd: sub, fetchImpl });
    expect(explicit.json).toMatchObject({ exitCode: 13, error: { code: "PENDING_STATE_INVALID" } });
  });
});
