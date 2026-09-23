/**
 * The grant client (plan §8 "Grant client") against a loopback `node:http`
 * fake of both planes (`test/fixtures/fake-planes.ts`). The fake approves by
 * encrypting with the portal's own `envelope.ts`. A fake clock is shared by
 * the CLI (`now`, `sleep`) and the fake server, so polling never waits in
 * real time.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliRuntime } from "../src/cli/main.js";
import { COMMANDS, createRegistry } from "../src/cli/registry.js";
import { GrantPayloadError, storeGrantCredentials, validateGrantPayload, type GrantPayload } from "../src/core/grant.js";
import { CredentialStore, resolveStorePaths } from "../src/core/credentials.js";
import { createServer } from "../src/mcp/server.js";
import { CLI_VERSION } from "../src/version.js";
import {
  DEVICE_CODE,
  FakePlanes,
  NORMALIZED_USER_CODE,
  READ_KEY,
  USER_CODE,
  VERIFICATION_URI,
  VISITOR_KEY,
} from "./fixtures/fake-planes.js";
import { Capture, builtBin, childEnv, run, tempDir, type RunResult } from "./helpers.js";

type Json = Record<string, unknown>;

let dir: string;
let cleanup: () => Promise<void>;
let store: string;
let project: string;
let home: string;
let planes: FakePlanes;
let clock: number;
let sleeps: number[];

const POLL = "POST /_developer/cli/grants/poll";
const ACK = "POST /_developer/cli/grants/poll (ack)";
const START = "POST /_developer/cli/grants";
const SIGNUP = "GET /_developer/signup";

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir("arcopolis-grant-"));
  store = path.join(dir, "store");
  project = path.join(dir, "my-project");
  home = path.join(dir, "home");
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  clock = Math.floor(Date.now() / 1000) * 1000;
  sleeps = [];
  planes = new FakePlanes(() => clock);
  await planes.start();
});

afterEach(async () => {
  await planes.stop();
  await cleanup();
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { ARCOPOLIS_CONFIG_DIR: store, ARCOPOLIS_API_BASE: planes.dataBase, ARCOPOLIS_DEVELOPER_BASE: planes.developerBase, ...extra };
}

function runtime(overrides: Partial<CliRuntime> = {}): Partial<CliRuntime> {
  return {
    env: env(),
    cwd: project,
    homedir: home,
    now: () => new Date(clock),
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      clock += ms;
    },
    ...overrides,
  };
}

function runGrant(argv: string[], overrides: Partial<CliRuntime> = {}): Promise<RunResult> {
  return run(argv, runtime(overrides));
}

/** A TTY run (stdin and stdout are terminals); prompts would read `stdin`. */
async function runTty(argv: string[], overrides: Partial<CliRuntime> = {}): Promise<RunResult> {
  const stdout = new Capture();
  const stderr = new Capture();
  const exitCode = await runCli({
    argv,
    stdin: new PassThrough(),
    stdout,
    stderr,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    ...(runtime(overrides) as CliRuntime),
  });
  const line = stdout.text.trim();
  let parsed: Json | null = null;
  try {
    parsed = line ? (JSON.parse(line) as Json) : null;
  } catch {
    parsed = null;
  }
  return { exitCode, stdout: stdout.text, stderr: stderr.text, json: parsed };
}

const PENDING_FILE = (): string => path.join(store, "pending-grant.json");
const CREDENTIALS_FILE = (): string => path.join(store, "credentials.json");

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(file: string): Promise<Json> {
  return JSON.parse(await readFile(file, "utf8")) as Json;
}

/** Starts a grant with a non-interactive run (exit 10) and clears the request log. */
async function startGrant(argv: string[] = ["setup", "--json"]): Promise<RunResult> {
  const result = await runGrant(argv);
  expect(result.exitCode, result.stdout).toBe(10);
  planes.requests.length = 0;
  return result;
}

function errorOf(result: RunResult): Json {
  return (result.json?.error ?? {}) as Json;
}

function noSecrets(result: RunResult, extra: string[] = []): void {
  const text = `${result.stdout}${result.stderr}`;
  for (const secret of [READ_KEY, VISITOR_KEY, DEVICE_CODE, ...extra]) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/agnts_(?:[a-z]+_)*[0-9a-f]{16,}/);
}

// ---------------------------------------------------------------------------

describe("first run without a TTY", () => {
  it("exits 10 APPROVAL_PENDING with the plan's humanAction and keeps the pending grant at 0600", async () => {
    const result = await runGrant(["setup", "--json"]);
    expect(result.exitCode).toBe(10);
    expect(planes.trace).toEqual([SIGNUP, START]);
    expect(result.json).toMatchObject({
      schemaVersion: 1,
      ok: false,
      command: "setup",
      exitCode: 10,
      error: {
        category: "needs_human",
        code: "APPROVAL_PENDING",
        message: "A person must approve this once in a browser.",
        surface: "local",
        retry: { strategy: "after_human" },
        humanDecision: true,
        hint: "Give the human the link and code exactly. Do not open it, approve it, or accept terms yourself.",
      },
      effects: { network: ["control"], requests: 2, writes: ["cli_grant"], spends: {}, secretsWritten: [] },
      next: [{ command: "arcopolis setup --json", why: "Re-run after the human approves; it resumes the same code and waits up to 90 seconds", humanDecision: false }],
    });
    expect(result.json?.humanAction).toEqual({
      verificationUriComplete: `${VERIFICATION_URI}#code=${USER_CODE}`,
      verificationUri: VERIFICATION_URI,
      userCode: USER_CODE,
      expiresInSeconds: 600,
      requested: { app: "my-project", readKey: { tier: 1 }, visitor: null },
      termsTheHumanWillSee: [{ name: "Developer/API Terms", version: "2026-07-20" }],
      tellTheHuman: `Open ${VERIFICATION_URI}#code=${USER_CODE} on any device, sign in with Google, check the code is ${USER_CODE}, and approve. Then tell me.`,
    });

    const start = planes.requests[1]?.body as Json;
    expect(Object.keys(start).sort()).toEqual(["client", "expectedEmailSha256", "intent", "publicKey"]);
    expect(start.client).toEqual({ name: "arcopolis-cli", version: CLI_VERSION, platform: `${process.platform}-${process.arch}`, hostLabel: expect.any(String) });
    expect(Object.keys(start.publicKey as Json).sort()).toEqual(["crv", "kty", "x", "y"]);
    expect(start.intent).toEqual({ kind: "setup", app: { name: "my-project" }, readKey: { name: expect.stringMatching(/^my-project CLI [0-9a-f]{6}$/), tier: 1 }, visitor: null });
    expect(start.expectedEmailSha256).toBeNull();
    const installId = ((await readJsonFile(path.join(store, "config.json"))) as { installId: string }).installId;
    expect((start.intent as { readKey: { name: string } }).readKey.name).toBe(`my-project CLI ${installId}`);

    expect((await stat(PENDING_FILE())).mode & 0o777).toBe(0o600);
    const pending = await readJsonFile(PENDING_FILE());
    expect(pending).toMatchObject({
      schemaVersion: 1,
      userCode: USER_CODE,
      deviceCode: DEVICE_CODE,
      interval: 5,
      profile: "default",
      envFile: null,
      expectedEmail: null,
      verificationUriComplete: `${VERIFICATION_URI}#code=${USER_CODE}`,
      developerBase: planes.developerBase,
      stored: null,
      request: { app: "my-project", readKey: { tier: 1 }, visitor: null },
    });
    const privateKey = pending.privateKeyJwk as { d: string; x: string };
    expect(privateKey.x).toBe((start.publicKey as Json).x);
    noSecrets(result, [privateKey.d]);
  });

  it("--visitor requests a visitor and lists the corpus terms", async () => {
    const result = await runGrant(["setup", "--visitor", "--world", "world_7", "--json"]);
    expect(result.exitCode).toBe(10);
    expect((planes.requests[1]?.body as Json).intent).toMatchObject({ visitor: { slug: "my-project", worldId: "world_7" } });
    expect(result.json?.humanAction).toMatchObject({
      requested: { visitor: { slug: "my-project", worldId: "world_7" } },
      termsTheHumanWillSee: [{ version: "2026-07-20" }, { name: "Visitor research-corpus terms", version: "2026-09-16" }],
    });
  });

  it("--expect-email sends only the hash and names the account in tellTheHuman", async () => {
    const result = await runGrant(["setup", "--expect-email", "Dev@Example.com", "--json"]);
    const hash = createHash("sha256").update("arcopolis-cli-expect-email-v1:dev@example.com").digest("hex");
    expect((planes.requests[1]?.body as Json).expectedEmailSha256).toBe(hash);
    expect(JSON.stringify(planes.requests[1]?.body)).not.toContain("example.com");
    expect((result.json?.humanAction as Json).tellTheHuman).toContain("sign in with Google as dev@example.com");
  });
});

describe("the re-run resumes the same code", () => {
  it("pending, claimed, approved: stores at 0600 before the ack, acks, verifies, and deletes the pending file", async () => {
    await startGrant();
    planes.onPoll = async (count, fake) => {
      if (count === 2) fake.requireGrant().status = "claimed";
      if (count === 3) await fake.approve();
    };
    let credentialsAtAck: string | null = null;
    planes.onAck = async () => {
      credentialsAtAck = await readFile(CREDENTIALS_FILE(), "utf8").catch(() => null);
      return true;
    };
    const result = await runGrant(["setup", "--json"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(planes.trace).toEqual([POLL, POLL, POLL, ACK, "GET /v1"]);
    expect(sleeps).toEqual([5000, 5000]);
    expect(credentialsAtAck).toContain(READ_KEY);
    expect(planes.requireGrant().status).toBe("consumed");
    expect(planes.requests.at(-1)?.apiKey).toBe(READ_KEY);
    expect(result.json).toMatchObject({
      ok: true,
      data: {
        profile: "default",
        mode: "grant",
        approvedBy: "dev@example.com",
        userCode: USER_CODE,
        app: { id: "app_1", name: "my-project", created: true },
        readKey: { id: "key_read_1", keyPrefix: "agnts_2ea1…", tier: 1, action: "created", verified: true },
        visitor: null,
        terms: { developer: "2026-07-20", visitorCorpus: null },
        files: [],
      },
      effects: { network: ["control", "data"], requests: 5, writes: ["credential_store"], spends: { rateLimit: 1 }, secretsWritten: ["credential_store:readKey"] },
      next: [{ command: "arcopolis agents list --per-page 5 --json" }, { command: "arcopolis exec -- node app.mjs" }],
    });
    expect(await exists(PENDING_FILE())).toBe(false);
    expect((await stat(CREDENTIALS_FILE())).mode & 0o777).toBe(0o600);
    const saved = (await readJsonFile(CREDENTIALS_FILE())) as { profiles: { default: Json } };
    expect(saved.profiles.default).toMatchObject({
      source: "grant",
      apiBase: planes.dataBase,
      developerBase: planes.developerBase,
      account: { uid: "uid_dev", email: "dev@example.com" },
      app: { id: "app_1", name: "my-project" },
      readKey: { id: "key_read_1", key: READ_KEY, tier: 1, origin: planes.origin, lastVerifiedAt: expect.any(String) },
      terms: { developer: "2026-07-20", visitorCorpus: null, acceptedVia: "portal_approval" },
    });
    noSecrets(result);
    // Resolved and verified: the next run exits 0 with no request.
    planes.requests.length = 0;
    const again = await runGrant(["setup", "--json"]);
    expect(again.exitCode).toBe(0);
    expect(again.json).toMatchObject({ data: { mode: "existing" } });
    expect(planes.trace).toEqual([]);
  });

  it("still pending: waits up to 90 seconds, then exits 10 with the same code (one start in total)", async () => {
    await startGrant();
    const result = await runGrant(["setup", "--json"]);
    expect(result.exitCode).toBe(10);
    expect(errorOf(result)).toMatchObject({ code: "APPROVAL_PENDING", details: { resumed: true, status: "pending" } });
    expect((result.json?.humanAction as Json).userCode).toBe(USER_CODE);
    expect(planes.trace.every((entry) => entry === POLL)).toBe(true);
    const waited = sleeps.reduce((sum, ms) => sum + ms, 0);
    expect(waited).toBeLessThanOrEqual(90_000);
    expect(waited).toBeGreaterThanOrEqual(85_000);
    expect(sleeps.every((ms) => ms === 5000)).toBe(true);
    expect(await exists(PENDING_FILE())).toBe(true);
  });

  it("an agent wait never exceeds 110 seconds, even with --wait 600", async () => {
    await startGrant();
    const result = await runGrant(["setup", "--wait", "600", "--json"]);
    expect(result.exitCode).toBe(10);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(110_000);
  });

  it("SLOW_DOWN waits Retry-After, slows the interval, and carries on", async () => {
    await startGrant();
    planes.pollQueue.push({ status: 429, body: { error: { code: "SLOW_DOWN", message: "Polling too fast." } }, headers: { "retry-after": "5" } });
    planes.onPoll = async (count, fake) => {
      if (count === 2) await fake.approve();
    };
    const result = await runGrant(["setup", "--json"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(sleeps[0]).toBe(5000);
    expect(planes.trace).toEqual([POLL, POLL, ACK, "GET /v1"]);
  });

  it("SLOW_DOWN with no time left to wait is exit 6 with retry.afterSeconds", async () => {
    await startGrant();
    planes.pollQueue.push({ status: 429, body: { error: { code: "SLOW_DOWN", message: "Polling too fast." } }, headers: { "retry-after": "5" } });
    const result = await runGrant(["setup", "--wait", "0", "--json"]);
    expect(result.exitCode).toBe(6);
    expect(errorOf(result)).toMatchObject({ code: "SLOW_DOWN", retry: { strategy: "after_seconds", afterSeconds: 5 } });
  });

  it("denied: exit 10 APPROVAL_DENIED, nothing stored, the pending file removed", async () => {
    await startGrant();
    planes.requireGrant().status = "denied";
    const result = await runGrant(["setup", "--json"]);
    expect(result.exitCode).toBe(10);
    expect(errorOf(result)).toMatchObject({ code: "APPROVAL_DENIED", category: "needs_human", humanDecision: true });
    expect(result.json?.next).toEqual([expect.objectContaining({ command: "arcopolis setup --new --json", humanDecision: true })]);
    expect(await exists(PENDING_FILE())).toBe(false);
    expect(await exists(CREDENTIALS_FILE())).toBe(false);
  });

  it("expired: exit 13 CLI_GRANT_EXPIRED with next setup --new", async () => {
    await startGrant();
    planes.requireGrant().status = "expired";
    const result = await runGrant(["setup", "--json"]);
    expect(result.exitCode).toBe(13);
    expect(errorOf(result)).toMatchObject({ code: "CLI_GRANT_EXPIRED", category: "conflict" });
    expect(result.json?.next).toEqual([expect.objectContaining({ command: "arcopolis setup --new --json" })]);
    expect(await exists(PENDING_FILE())).toBe(false);
  });

  it("a grant past every deadline is not polled: a plain run starts a new code, --resume exits 13", async () => {
    await startGrant();
    clock += 31 * 60_000;
    const resumed = await runGrant(["setup", "--resume", "--json"]);
    expect(resumed.exitCode).toBe(13);
    expect(errorOf(resumed)).toMatchObject({ code: "CLI_GRANT_EXPIRED" });
    expect(planes.trace).toEqual([]);
    await startGrant();
    clock += 31 * 60_000;
    const fresh = await runGrant(["setup", "--json"]);
    expect(fresh.exitCode).toBe(10);
    expect(planes.trace).toEqual([SIGNUP, START]);
    expect(fresh.json?.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PENDING_GRANT_EXPIRED" })]));
  });

  it("--resume with nothing pending is exit 5 GRANT_NOT_STARTED with no request", async () => {
    const result = await runGrant(["setup", "--resume", "--json"]);
    expect(result.exitCode).toBe(5);
    expect(errorOf(result)).toMatchObject({ code: "GRANT_NOT_STARTED" });
    expect(planes.trace).toEqual([]);
  });

  it("--new discards the pending grant and starts a new code", async () => {
    await startGrant();
    const result = await runGrant(["setup", "--new", "--json"]);
    expect(result.exitCode).toBe(10);
    expect(planes.trace).toEqual([SIGNUP, START]);
  });

  it("a run that asks for something else checks the pending grant once, then replaces it", async () => {
    await startGrant();
    const result = await runGrant(["setup", "--visitor", "--json"]);
    expect(result.exitCode).toBe(10);
    expect(planes.trace).toEqual([POLL, SIGNUP, START]);
    expect(result.json?.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PENDING_GRANT_REPLACED" })]));
    expect((planes.requests[2]?.body as Json).intent).toMatchObject({ visitor: { slug: "my-project" } });
  });

  it("repeating a command whose visitor was dropped (no world open) resumes the same code", async () => {
    planes.visitorWorldsOpen = 0;
    const first = await startGrant(["setup", "--visitor", "--json"]);
    expect(first.json?.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "VISITOR_DROPPED" })]));
    expect((await readJsonFile(PENDING_FILE())).request).toMatchObject({ visitor: null });
    const again = await runGrant(["setup", "--visitor", "--json"]);
    expect(again.exitCode).toBe(10);
    expect(errorOf(again)).toMatchObject({ code: "APPROVAL_PENDING", details: { resumed: true } });
    expect(planes.trace.every((entry) => entry === POLL)).toBe(true);
    expect(JSON.stringify(again.json?.warnings ?? [])).not.toContain("PENDING_GRANT_REPLACED");
  });

  it("repeating a command whose read key already resolved (--visitor --tier 2) resumes the same code", async () => {
    await mkdir(store, { recursive: true, mode: 0o700 });
    const readKey = { key: READ_KEY, tier: 1, origin: planes.origin, savedAt: new Date(clock).toISOString(), lastVerifiedAt: new Date(clock).toISOString() };
    await writeFile(CREDENTIALS_FILE(), JSON.stringify({ schemaVersion: 1, profiles: { default: { source: "import", readKey } } }), { mode: 0o600 });
    await startGrant(["setup", "--visitor", "--tier", "2", "--json"]);
    expect((await readJsonFile(PENDING_FILE())).request).toMatchObject({ readKey: null, visitor: { slug: "my-project" } });
    const again = await runGrant(["setup", "--visitor", "--tier", "2", "--json"]);
    expect(again.exitCode).toBe(10);
    expect(planes.trace.every((entry) => entry === POLL)).toBe(true);
  });

  it("a conflicting run finishes an approval the human already gave instead of replacing it", async () => {
    await startGrant();
    await planes.approve();
    const result = await runGrant(["setup", "--visitor", "--json"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(planes.trace).toEqual([POLL, ACK, "GET /v1"]);
    expect(result.json).toMatchObject({ data: { mode: "grant", userCode: USER_CODE, readKey: { id: "key_read_1", verified: true } } });
    expect(result.json?.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PENDING_GRANT_FINISHED" })]));
    expect(await exists(PENDING_FILE())).toBe(false);
  });

  it("a conflicting run never replaces a grant whose page the human has open", async () => {
    await startGrant();
    planes.requireGrant().status = "claimed";
    const result = await runGrant(["setup", "--visitor", "--json"]);
    expect(result.exitCode).toBe(10);
    expect(errorOf(result)).toMatchObject({ code: "APPROVAL_PENDING", details: { status: "claimed", conflict: "a visitor" } });
    expect(result.json?.next).toEqual([
      expect.objectContaining({ command: "arcopolis setup --json" }),
      expect.objectContaining({ command: "arcopolis setup --new --json", humanDecision: true }),
    ]);
    expect(planes.trace).toEqual([POLL]);
    expect((await readJsonFile(PENDING_FILE())).userCode).toBe(USER_CODE);
  });
});

describe("the approved payload", () => {
  it("--expect-email mismatch: exit 4 APPROVER_MISMATCH, nothing stored, the approval acknowledged", async () => {
    await startGrant(["setup", "--expect-email", "other@example.com", "--json"]);
    await planes.approve();
    const result = await runGrant(["setup", "--json"]);
    expect(result.exitCode).toBe(4);
    expect(errorOf(result)).toMatchObject({
      code: "APPROVER_MISMATCH",
      category: "forbidden",
      details: { expectedEmail: "other@example.com", approvedBy: "dev@example.com" },
    });
    expect(errorOf(result).message).toContain("dev@example.com");
    expect(errorOf(result).message).toContain("other@example.com");
    expect(planes.acks).toBe(1);
    expect(await exists(CREDENTIALS_FILE())).toBe(false);
    expect(await exists(PENDING_FILE())).toBe(false);
    noSecrets(result);
  });

  it("--expect-email match (any case) succeeds", async () => {
    await startGrant(["setup", "--expect-email", "DEV@example.com", "--json"]);
    await planes.approve();
    const result = await runGrant(["setup", "--json"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.json).toMatchObject({ data: { approvedBy: "dev@example.com" } });
  });

  it("a userCode mismatch rejects the payload with no ack and keeps the pending grant", async () => {
    await startGrant();
    await planes.approve(planes.payload({ userCode: "BCDFGHJK" }));
    const result = await runGrant(["setup", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(errorOf(result)).toMatchObject({ code: "GRANT_PAYLOAD_INVALID", category: "internal", details: { field: "userCode" } });
    expect(planes.acks).toBe(0);
    expect(planes.requireGrant().status).toBe("approved");
    expect(await exists(PENDING_FILE())).toBe(true);
    expect(await exists(CREDENTIALS_FILE())).toBe(false);
    noSecrets(result);
  });

  it("an envelope bound to another code never decrypts (no ack)", async () => {
    await startGrant();
    await planes.approve(planes.payload(), { encryptForCode: "BCDFGHJK" });
    const result = await runGrant(["setup", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(errorOf(result)).toMatchObject({ code: "GRANT_PAYLOAD_INVALID", details: { field: "envelope" } });
    expect(planes.acks).toBe(0);
  });

  it("a non-canonical apiBase or a malformed key is refused before anything is stored", async () => {
    await startGrant();
    await planes.approve(planes.payload({ apiBase: "https://evil.example/v1" }));
    const custom = await runGrant(["setup", "--json"]);
    expect(errorOf(custom)).toMatchObject({ code: "GRANT_PAYLOAD_INVALID", details: { field: "apiBase" } });
    await planes.approve(planes.payload({ readKey: { ...(planes.payload().readKey as Json), key: "agnts_short" } }));
    const badKey = await runGrant(["setup", "--json"]);
    expect(errorOf(badKey)).toMatchObject({ code: "GRANT_PAYLOAD_INVALID", details: { field: "readKey.key" } });
    expect(planes.acks).toBe(0);
    expect(await exists(CREDENTIALS_FILE())).toBe(false);
  });

  it("a registered visitor is stored with its budget and corpus terms; both keys are verified", async () => {
    await startGrant(["setup", "--visitor", "--json"]);
    await planes.approve(
      planes.payload({
        visitor: {
          agentId: "agent_visitor_1",
          handle: "visitor-my-project",
          worldId: "world_7",
          keyId: "key_drive_1",
          key: VISITOR_KEY,
          tier: 2,
          scopes: ["agents:drive"],
          rateLimitPerMinute: 60,
          driveDailyBudget: 25,
          keyCreatedAt: new Date(clock).toISOString(),
          action: "registered",
        },
        warnings: ["A note from the approval page."],
      }),
    );
    const result = await runGrant(["setup", "--json"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(planes.trace).toEqual([POLL, ACK, "GET /v1", "GET /v1"]);
    expect(planes.requests.slice(-2).map((request) => request.apiKey)).toEqual([READ_KEY, VISITOR_KEY]);
    expect(result.json).toMatchObject({
      data: {
        visitor: { agentId: "agent_visitor_1", handle: "visitor-my-project", keyPrefix: "agnts_4a79…", driveDailyBudget: 25, action: "registered", verified: true },
        terms: { developer: "2026-07-20", visitorCorpus: "2026-09-16" },
      },
      effects: { secretsWritten: ["credential_store:readKey", "credential_store:visitorKey"] },
      warnings: expect.arrayContaining([{ code: "GRANT_WARNING", message: "A note from the approval page." }]),
    });
    const saved = (await readJsonFile(CREDENTIALS_FILE())) as { profiles: { default: { visitor: Json; terms: Json } } };
    expect(saved.profiles.default.visitor).toMatchObject({ agentId: "agent_visitor_1", keyId: "key_drive_1", key: VISITOR_KEY, driveDailyBudget: 25, origin: planes.origin });
    expect(saved.profiles.default.terms).toEqual({ developer: "2026-07-20", visitorCorpus: "2026-09-16", acceptedVia: "portal_approval" });
    noSecrets(result);
  });

  it("inside a git repository: arcopolis.json, the .gitignore block, and the env file asked for at the start", async () => {
    execFileSync("git", ["init", "-q"], { cwd: project, stdio: "ignore" });
    await startGrant(["setup", "--write-env-file", ".env.arcopolis", "--json"]);
    await planes.approve();
    const result = await runGrant(["setup", "--json"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.json).toMatchObject({ data: { files: [".gitignore", "arcopolis.json", ".env.arcopolis"] } });
    expect(await readJsonFile(path.join(project, "arcopolis.json"))).toMatchObject({ schemaVersion: 1, profile: "default" });
    const gitignore = await readFile(path.join(project, ".gitignore"), "utf8");
    expect(gitignore).toContain(".arcopolis-*");
    expect(gitignore).toContain(".env.arcopolis");
    const envFile = await readFile(path.join(project, ".env.arcopolis"), "utf8");
    expect(envFile).toContain(`ARCOPOLIS_API_BASE=${planes.dataBase}`);
    expect(envFile).toContain(`ARCOPOLIS_API_KEY=${READ_KEY}`);
    expect((await stat(path.join(project, ".env.arcopolis"))).mode & 0o777).toBe(0o600);
    noSecrets(result);
  });

  it("a crash between the store and the ack: the next run fetches the envelope again, stores, and acks", { timeout: 60_000 }, async () => {
    const bin = builtBin();
    await startGrant();
    await planes.approve();
    let credentialsAtAck: string | null = null;
    const child = spawn(process.execPath, [bin, "setup", "--json"], {
      cwd: project,
      env: childEnv({ HOME: home, ...env() }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    planes.onAck = async () => {
      credentialsAtAck = await readFile(CREDENTIALS_FILE(), "utf8").catch(() => null);
      child.kill("SIGKILL");
      return false;
    };
    const code = await new Promise<number | null>((resolve) => child.on("close", (exit, signal) => resolve(signal ? -1 : exit)));
    expect(code).toBe(-1);
    expect(credentialsAtAck).toContain(READ_KEY);
    expect(planes.requireGrant().status).toBe("approved");
    const pending = await readJsonFile(PENDING_FILE());
    expect(pending.stored).toMatchObject({ readKey: { id: "key_read_1", action: "created" } });

    planes.onAck = null;
    planes.requests.length = 0;
    const result = await runGrant(["setup", "--json"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(planes.trace).toEqual([POLL, ACK, "GET /v1"]);
    expect(planes.requireGrant().status).toBe("consumed");
    expect(result.json).toMatchObject({ data: { mode: "grant", readKey: { keyPrefix: "agnts_2ea1…", verified: true } } });
    expect(await exists(PENDING_FILE())).toBe(false);
  });

  it("a crash after the ack: the next run sees consumed and finishes from the store", { timeout: 60_000 }, async () => {
    const bin = builtBin();
    await startGrant();
    await planes.approve();
    const child = spawn(process.execPath, [bin, "setup", "--json"], {
      cwd: project,
      env: childEnv({ HOME: home, ...env() }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    planes.onVerify = async () => {
      child.kill("SIGKILL");
      return false;
    };
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    expect(planes.requireGrant().status).toBe("consumed");
    expect(await exists(PENDING_FILE())).toBe(true);

    planes.onVerify = null;
    planes.requests.length = 0;
    const result = await runGrant(["setup", "--json"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(planes.trace).toEqual([POLL, "GET /v1"]);
    expect(result.json).toMatchObject({ data: { mode: "grant", approvedBy: "dev@example.com", readKey: { id: "key_read_1", verified: true } } });
    expect(await exists(PENDING_FILE())).toBe(false);
  });

  describe("keys stored before a crash are never reported as expired", () => {
    /** Runs an approval to completion, then puts back the pending file as it was just before the ack (a crash there). */
    async function crashBeforeAck(): Promise<void> {
      await startGrant();
      await planes.approve();
      let snapshot: string | null = null;
      planes.onAck = async () => {
        snapshot = await readFile(PENDING_FILE(), "utf8");
        return true;
      };
      const done = await runGrant(["setup", "--no-verify", "--json"]);
      expect(done.exitCode, done.stdout).toBe(0);
      planes.onAck = null;
      expect(snapshot).toContain('"stored"');
      await writeFile(PENDING_FILE(), snapshot ?? "", { mode: 0o600 });
      planes.requests.length = 0;
    }

    it("the server says expired: finishes from the store", async () => {
      await crashBeforeAck();
      planes.requireGrant().status = "expired";
      const result = await runGrant(["setup", "--json"]);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(planes.trace).toEqual([POLL, "GET /v1"]);
      expect(result.json).toMatchObject({ data: { mode: "grant", readKey: { id: "key_read_1", verified: true } } });
      expect(result.json?.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "GRANT_NOT_ACKNOWLEDGED" })]));
      expect(await exists(PENDING_FILE())).toBe(false);
    });

    it("the server no longer knows the code: finishes from the store", async () => {
      await crashBeforeAck();
      planes.grant = null;
      const result = await runGrant(["setup", "--json"]);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(result.json).toMatchObject({ data: { mode: "grant", readKey: { id: "key_read_1" } } });
    });

    it("past every deadline: --resume and a plain run finish from the store with no poll", async () => {
      await crashBeforeAck();
      const snapshot = await readFile(PENDING_FILE(), "utf8");
      clock += 31 * 60_000;
      const resumed = await runGrant(["setup", "--resume", "--json"]);
      expect(resumed.exitCode, resumed.stdout).toBe(0);
      expect(planes.trace).toEqual(["GET /v1"]);
      expect(resumed.json).toMatchObject({ data: { mode: "grant", readKey: { id: "key_read_1" } } });
      await writeFile(PENDING_FILE(), snapshot, { mode: 0o600 });
      const plain = await runGrant(["setup", "--json"]);
      expect(plain.exitCode, plain.stdout).toBe(0);
      expect(plain.json).toMatchObject({ data: { mode: "grant" } });
      expect(await exists(PENDING_FILE())).toBe(false);
    });
  });

  it("a failed ack still finishes: the keys are stored and the approval expires on its own", async () => {
    await startGrant();
    await planes.approve();
    planes.ackQueue.push({ status: 500, body: { error: { code: "INTERNAL_ERROR", message: "boom" } } });
    const result = await runGrant(["setup", "--json"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.json?.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "GRANT_ACK_FAILED" }), expect.objectContaining({ code: "GRANT_NOT_ACKNOWLEDGED" })]),
    );
    expect(await exists(PENDING_FILE())).toBe(false);
    expect(await readFile(CREDENTIALS_FILE(), "utf8")).toContain(READ_KEY);
  });
});

describe("grants unavailable: the guided fallback", () => {
  const cases: Array<[number, string]> = [
    [401, "UNAUTHORIZED"],
    [404, "NOT_FOUND"],
    [503, "CLI_GRANTS_DISABLED"],
    [503, "DEVELOPER_PORTAL_DISABLED"],
  ];
  for (const [status, code] of cases) {
    it(`R1 ${status} ${code} falls back to HUMAN_SETUP_REQUIRED with no pending grant`, async () => {
      planes.startResponse = { status, body: { error: { code, message: "unavailable" } } };
      const result = await runGrant(["setup", "--json"]);
      expect(result.exitCode).toBe(10);
      expect(errorOf(result)).toMatchObject({ code: "HUMAN_SETUP_REQUIRED" });
      expect(result.json?.humanAction).toMatchObject({ mode: "guided" });
      expect(result.json?.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "CLI_GRANTS_UNAVAILABLE" })]));
      expect(planes.trace).toEqual([SIGNUP, START]);
      expect(await exists(PENDING_FILE())).toBe(false);
    });
  }

  it("a 500 on R1 is not a fallback: exit 12", async () => {
    planes.startResponse = { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "boom" } } };
    const result = await runGrant(["setup", "--json"]);
    expect(result.exitCode).toBe(12);
    expect(errorOf(result)).toMatchObject({ code: "INTERNAL_ERROR" });
  });
});

describe("in a terminal", () => {
  it("prints the plan, link, and code, opens the browser, and polls until approved", async () => {
    const opened: string[] = [];
    planes.onPoll = async (count, fake) => {
      if (count === 2) await fake.approve();
    };
    const result = await runTty(["setup", "--json"], {
      openUrl: async (url: string): Promise<boolean> => {
        opened.push(url);
        return true;
      },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(opened).toEqual([`${VERIFICATION_URI}#code=${USER_CODE}`]);
    expect(result.stderr).toContain("Plan: app \"my-project\" · 1 read key (tier 1)");
    expect(result.stderr).toContain(`Open  ${VERIFICATION_URI}#code=${USER_CODE}   (opened in your browser)`);
    expect(result.stderr).toContain(`Code  ${USER_CODE}`);
    expect(result.stderr).toContain("the Developer/API Terms (2026-07-20)");
    expect(result.stderr).toContain("Waiting for approval... approved.");
    expect(result.json).toMatchObject({ data: { mode: "grant", readKey: { verified: true } } });
    expect(planes.trace).toEqual([SIGNUP, START, POLL, POLL, ACK, "GET /v1"]);
    noSecrets(result);
  });

  it("--no-browser does not open anything; human output summarizes the approval", async () => {
    const opened: string[] = [];
    planes.onPoll = async (count, fake) => {
      if (count === 1) await fake.approve();
    };
    const result = await runTty(["setup", "--no-browser"], {
      openUrl: async (url: string): Promise<boolean> => {
        opened.push(url);
        return true;
      },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(opened).toEqual([]);
    expect(result.stdout).toContain("Approved by dev@example.com (code WDJB-MJHT)");
    expect(result.stdout).toContain("Read key  agnts_2ea1…");
    noSecrets(result);
  });
});

describe("payload validation", () => {
  const base = (): Json => new FakePlanes().payload();
  const validate = (payload: Json): GrantPayload =>
    validateGrantPayload(payload, { normalizedUserCode: NORMALIZED_USER_CODE, allowedApiBases: ["https://api.arcopolis.ai/v1", "http://127.0.0.1:1/v1"] });
  const withBase = (overrides: Json): Json => ({ ...base(), apiBase: "https://api.arcopolis.ai/v1", ...overrides });
  const rotatedVisitor = {
    agentId: "agent_1",
    handle: "visitor-x",
    worldId: "world_7",
    keyId: "key_2",
    key: VISITOR_KEY,
    tier: 2,
    scopes: ["agents:drive"],
    rateLimitPerMinute: 60,
    driveDailyBudget: null,
    keyCreatedAt: "2026-09-23T15:00:00.000Z",
    action: "rotated",
  };

  it("accepts a rotated visitor with driveDailyBudget null and terms.visitorCorpus null", () => {
    const payload = validate(withBase({ readKey: null, visitor: rotatedVisitor }));
    expect(payload.visitor).toMatchObject({ action: "rotated", driveDailyBudget: null });
    expect(payload.terms.visitorCorpus).toBeNull();
  });

  it("accepts a null account email and a null keyCreatedAt", () => {
    const payload = validate(withBase({ account: { uid: "u", email: null }, readKey: null, visitor: { ...rotatedVisitor, keyCreatedAt: null } }));
    expect(payload.account.email).toBeNull();
  });

  it("accepts app and key names as long as the portal allows (an existing app or a rotated key)", () => {
    const longApp = "A long application name that someone typed in the old portal UI";
    const longKey = `${"k".repeat(150)} rotated key`;
    const payload = validate(withBase({ app: { id: "app_1", name: longApp, created: false }, readKey: { ...(base().readKey as Json), name: longKey, action: "rotated" } }));
    expect(payload.app.name).toBe(longApp);
    expect(payload.readKey?.name).toBe(longKey);
    expect(() => validate(withBase({ app: { id: "app_1", name: "x".repeat(501), created: false } }))).toThrow(GrantPayloadError);
    expect(() => validate(withBase({ readKey: { ...(base().readKey as Json), name: "bad\u0007name" } }))).toThrow(GrantPayloadError);
  });

  it("rejects each rule with the field named", () => {
    const registered = { ...rotatedVisitor, action: "registered", driveDailyBudget: 25 };
    const corpus = { version: "2026-09-16", text: "Visitor text becomes part of the research corpus." };
    const terms = (base().terms as Json);
    const cases: Array<[Json, string]> = [
      [withBase({ v: 2 }), "v"],
      [withBase({ userCode: "BCDFGHJK" }), "userCode"],
      [withBase({ apiBase: "https://api.arcopolis.ai/v2" }), "apiBase"],
      [withBase({ readKey: null, visitor: null }), "readKey"],
      [withBase({ readKey: { ...(base().readKey as Json), tier: 4 } }), "readKey.tier"],
      [withBase({ readKey: { ...(base().readKey as Json), scopes: [] } }), "readKey.scopes"],
      [withBase({ readKey: { ...(base().readKey as Json), action: "minted" } }), "readKey.action"],
      [withBase({ app: { id: "a/b", name: "x", created: true } }), "app.id"],
      [withBase({ visitor: registered }), "terms.visitorCorpus"],
      [withBase({ visitor: rotatedVisitor, terms: { ...terms, visitorCorpus: corpus } }), "terms.visitorCorpus"],
      [withBase({ terms: { ...terms, visitorCorpus: corpus } }), "terms.visitorCorpus"],
      [withBase({ visitor: { ...rotatedVisitor, driveDailyBudget: -1 } }), "visitor.driveDailyBudget"],
      [withBase({ visitor: { ...rotatedVisitor, key: READ_KEY } }), "visitor.key"],
      [withBase({ terms: { ...terms, developer: { version: "July", url: "https://x" } } }), "terms.developer.version"],
      [withBase({ warnings: "none" }), "warnings"],
      [withBase({ approvedAt: "yesterday" }), "approvedAt"],
    ];
    for (const [payload, field] of cases) {
      let caught: unknown = null;
      try {
        validate(payload);
      } catch (error) {
        caught = error;
      }
      expect(caught, field).toBeInstanceOf(GrantPayloadError);
      expect((caught as GrantPayloadError).field, field).toBe(field);
    }
  });

  it("a rotated visitor keeps the stored daily budget of the same agent", async () => {
    const credentialStore = new CredentialStore(resolveStorePaths({ env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project }));
    await mkdir(store, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(store, "credentials.json"),
      JSON.stringify({ schemaVersion: 1, profiles: { default: { source: "grant", visitor: { agentId: "agent_1", key: VISITOR_KEY, driveDailyBudget: 25, origin: "https://api.arcopolis.ai", savedAt: "x" } } } }),
      { mode: 0o600 },
    );
    const payload = validate(withBase({ readKey: null, visitor: rotatedVisitor }));
    await storeGrantCredentials(credentialStore, { profile: "default", payload, developerBase: "https://developers.arcologylabs.com/_developer", savedAt: new Date(clock).toISOString() });
    const saved = (await readJsonFile(CREDENTIALS_FILE())) as { profiles: { default: { visitor: Json } } };
    expect(saved.profiles.default.visitor).toMatchObject({ keyId: "key_2", driveDailyBudget: 25, origin: "https://api.arcopolis.ai" });
  });
});

describe("MCP setup tools", () => {
  async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
    const app = createServer({
      base: {
        env: env(),
        cwd: project,
        mode: { json: true, interactive: false, nonInteractiveReasons: ["test"], demo: false, verbose: false, quiet: false, timeoutMs: null, mcp: true },
        registry: createRegistry(COMMANDS, CLI_VERSION),
        version: CLI_VERSION,
        userAgent: `arcopolis-cli/${CLI_VERSION} node/test test mcp`,
        now: () => new Date(clock),
        sleep: async (ms: number): Promise<void> => {
          sleeps.push(ms);
          clock += ms;
        },
        homedir: home,
      },
      allowWrites: false,
      writePolicy: "flag",
      diagnostics: () => undefined,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await app.mcp.connect(serverTransport);
    const client = new Client({ name: "arcopolis-grant-test", version: "0.0.0" });
    await client.connect(clientTransport);
    return {
      client,
      close: async () => {
        await client.close();
        await app.mcp.close();
      },
    };
  }

  it("start returns humanAction; finish waits at most 30 s, then stores, acks, and returns a redacted summary", async () => {
    const session = await connect();
    try {
      const start = (await session.client.callTool({ name: "arcopolis_setup_start", arguments: {} })) as CallToolResult;
      expect(start.isError).toBeFalsy();
      const startDoc = start.structuredContent as Json;
      expect(startDoc).toMatchObject({ ok: true, data: { status: "pending", resumed: false, userCode: USER_CODE, humanAction: { userCode: USER_CODE } } });
      const text = start.content[0]?.type === "text" ? start.content[0].text : "";
      expect(text).toContain(`Tell the human exactly: Open ${VERIFICATION_URI}#code=${USER_CODE}`);

      const again = (await session.client.callTool({ name: "arcopolis_setup_start", arguments: {} })) as CallToolResult;
      expect((again.structuredContent as Json).data).toMatchObject({ status: "pending", resumed: true, userCode: USER_CODE });
      expect(planes.trace.filter((entry) => entry === START)).toHaveLength(1);

      const waiting = (await session.client.callTool({ name: "arcopolis_setup_finish", arguments: {} })) as CallToolResult;
      expect(waiting.isError).toBe(true);
      expect((waiting.structuredContent as Json).error).toMatchObject({ code: "APPROVAL_PENDING", exitCode: 10 });
      expect((waiting.structuredContent as Json).next).toEqual([expect.objectContaining({ command: "arcopolis_setup_finish" })]);
      expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(30_000);

      await planes.approve();
      const done = (await session.client.callTool({ name: "arcopolis_setup_finish", arguments: {} })) as CallToolResult;
      expect(done.isError).toBeFalsy();
      expect(done.structuredContent).toMatchObject({ ok: true, command: "arcopolis_setup_finish", data: { mode: "grant", approvedBy: "dev@example.com", readKey: { keyPrefix: "agnts_2ea1…", verified: true } } });
      const serialized = JSON.stringify([start, again, waiting, done]);
      expect(serialized).not.toContain(READ_KEY);
      expect(serialized).not.toContain(DEVICE_CODE);
      expect(serialized).not.toMatch(/"d":"/);
      expect(await exists(PENDING_FILE())).toBe(false);
    } finally {
      await session.close();
    }
  });

  it("start {visitor:true} twice with no visitor world open resumes the same code; a later conflicting start finishes an approved grant", async () => {
    planes.visitorWorldsOpen = 0;
    const session = await connect();
    try {
      const first = (await session.client.callTool({ name: "arcopolis_setup_start", arguments: { visitor: true } })) as CallToolResult;
      expect((first.structuredContent as Json).data).toMatchObject({ status: "pending", resumed: false });
      const again = (await session.client.callTool({ name: "arcopolis_setup_start", arguments: { visitor: true } })) as CallToolResult;
      expect((again.structuredContent as Json).data).toMatchObject({ status: "pending", resumed: true, userCode: USER_CODE });
      expect(planes.trace.filter((entry) => entry === START)).toHaveLength(1);

      await planes.approve();
      const other = (await session.client.callTool({ name: "arcopolis_setup_start", arguments: { visitor: true, tier: 2 } })) as CallToolResult;
      expect(other.isError).toBeFalsy();
      expect((other.structuredContent as Json).data).toMatchObject({ mode: "grant", readKey: { id: "key_read_1" } });
      expect(other.content[0]?.type === "text" ? other.content[0].text : "").toContain("Setup done: approved by dev@example.com");
      expect(planes.trace.filter((entry) => entry === START)).toHaveLength(1);
      expect(planes.requireGrant().status).toBe("consumed");
    } finally {
      await session.close();
    }
  });

  it("finish with nothing pending is GRANT_NOT_STARTED pointing at arcopolis_setup_start", async () => {
    const session = await connect();
    try {
      const result = (await session.client.callTool({ name: "arcopolis_setup_finish", arguments: {} })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect((result.structuredContent as Json).error).toMatchObject({ code: "GRANT_NOT_STARTED", exitCode: 5 });
      expect((result.structuredContent as Json).next).toEqual([expect.objectContaining({ command: "arcopolis_setup_start" })]);
      expect(planes.trace).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
