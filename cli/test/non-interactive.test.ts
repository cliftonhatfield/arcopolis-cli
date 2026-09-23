/**
 * Non-interactive contract on the built CLI (plan §3.3 and §8): every write
 * command runs as a real `node dist/bin.js` process with a piped stdin that
 * is never closed (as an agent harness leaves it), against a loopback HTTP
 * server standing in for both planes. Each must exit 10 within 5 s without
 * reading stdin and without sending a request.
 *
 * `setup` is the one plan-sanctioned exception to "zero requests": its step 2
 * is `GET /_developer/signup` (no auth, no writes) and step 3 starts the
 * approval grant (`POST /_developer/cli/grants`). With grants on it exits 10
 * `APPROVAL_PENDING`; with them off (503 `CLI_GRANTS_DISABLED`, production
 * until armed) it falls back and exits 10 `HUMAN_SETUP_REQUIRED`. It must
 * send nothing else.
 */
import { execFileSync } from "node:child_process";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { keyFingerprint } from "../src/visitor/actions.js";
import { serializePendingState, type PendingState } from "../src/visitor/pending.js";
import { RAW_KEY_PATTERN, builtBin, childEnv, fakeKey, spawnCli, tempDir, type ProcessResult } from "./helpers.js";

const DEADLINE_MS = 5_000;
const READ_KEY = fakeKey("a");
const VISITOR_KEY = fakeKey("b");
const AGENT = "visitor_ada";

let server: Server;
let origin: string;
let requests: string[] = [];
/** How the fake answers the grant start: 503 CLI_GRANTS_DISABLED (as before arming) or a new grant. */
let grants: "disabled" | "enabled" = "disabled";
let root: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  builtBin();
  ({ dir: root, cleanup } = await tempDir("arcopolis-noninteractive-"));
  server = createServer((request, response) => {
    requests.push(`${request.method ?? "?"} ${request.url ?? "?"}`);
    if (request.method === "POST" && request.url === "/_developer/cli/grants") {
      request.resume();
      response.writeHead(grants === "enabled" ? 201 : 503, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          grants === "enabled"
            ? {
                data: {
                  userCode: "WDJB-MJHT",
                  deviceCode: `agnts_dc_${"1".repeat(64)}`,
                  verificationUri: "https://developers.arcologylabs.com/cli",
                  verificationUriComplete: "https://developers.arcologylabs.com/cli#code=WDJB-MJHT",
                  expiresAt: new Date(Date.now() + 600_000).toISOString(),
                  expiresIn: 600,
                  interval: 5,
                },
              }
            : { error: { code: "CLI_GRANTS_DISABLED", message: "CLI setup is turned off right now." } },
        ),
      );
      return;
    }
    const signup = request.url === "/_developer/signup";
    response.writeHead(signup ? 200 : 418, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        signup
          ? { data: { open: true, termsVersion: "2026-09-16", visitorWorlds: { open: 1 } } }
          : { error: { code: "UNEXPECTED_REQUEST", message: "the non-interactive test expected no request" } },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

beforeEach(() => {
  requests = [];
  grants = "disabled";
});

/** A project directory and a credential store holding a read key bound to the loopback origin. */
async function sandbox(name: string, options: { storedKey?: boolean } = {}): Promise<{ project: string; config: string; home: string }> {
  const base = path.join(root, name);
  const project = path.join(base, "project");
  const config = path.join(base, "config");
  const home = path.join(base, "home");
  await Promise.all([mkdir(project, { recursive: true }), mkdir(config, { recursive: true, mode: 0o700 }), mkdir(home, { recursive: true })]);
  if (options.storedKey ?? true) {
    const file = path.join(config, "credentials.json");
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        profiles: { default: { source: "import", readKey: { key: READ_KEY, origin, savedAt: "2026-09-01T00:00:00.000Z" } } },
      }),
    );
    await chmod(file, 0o600);
  }
  return { project, config, home };
}

function env(box: { config: string; home: string }, extra: Record<string, string> = {}): Record<string, string> {
  return childEnv({
    HOME: box.home,
    ARCOPOLIS_CONFIG_DIR: box.config,
    ARCOPOLIS_API_BASE: `${origin}/v1`,
    ARCOPOLIS_DEVELOPER_BASE: `${origin}/_developer`,
    ...extra,
  });
}

const visitorEnv = { ARCOPOLIS_VISITOR_API_KEY: VISITOR_KEY, ARCOPOLIS_VISITOR_AGENT_ID: AGENT };

/** Runs one command with stdin piped and left open; SIGKILL one second after the deadline. */
function runOpenStdin(args: string[], box: { project: string; config: string; home: string }, extra: Record<string, string> = {}): Promise<ProcessResult> {
  return spawnCli([...args, "--json"], { cwd: box.project, env: env(box, extra), closeStdin: false, killAfterMs: DEADLINE_MS + 1_000 });
}

function expectHumanExit(result: ProcessResult, code: string): Record<string, unknown> {
  expect(result.killed, `killed at the deadline; stderr: ${result.stderr}`).toBe(false);
  expect(result.ms, "must exit within 5 s").toBeLessThan(DEADLINE_MS);
  const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");
  expect(lines, result.stderr).toHaveLength(1);
  const doc = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  expect(result.exitCode, JSON.stringify(doc)).toBe(10);
  expect(doc).toMatchObject({ schemaVersion: 1, ok: false, exitCode: 10, error: { category: "needs_human", code } });
  expect(`${result.stdout}${result.stderr}`).not.toMatch(RAW_KEY_PATTERN);
  return doc;
}

describe("write commands with piped stdin exit 10 within 5 s and send nothing (dist/bin.js)", () => {
  it("visitor heartbeat", async () => {
    const box = await sandbox("heartbeat");
    const doc = expectHumanExit(await runOpenStdin(["visitor", "heartbeat"], box, visitorEnv), "CONFIRMATION_REQUIRED");
    expect(doc).toMatchObject({ error: { humanDecision: true }, effects: { requests: 0 } });
    expect(requests).toEqual([]);
  });

  it("visitor act with action flags", async () => {
    const box = await sandbox("act-flags");
    const doc = expectHumanExit(await runOpenStdin(["visitor", "act", "--post", "hello from a test"], box, visitorEnv), "CONFIRMATION_REQUIRED");
    expect(doc).toMatchObject({ data: { preview: { post: { text: "hello from a test" } } }, effects: { requests: 0 } });
    expect(JSON.stringify(doc)).not.toContain("--execute --json");
    expect(requests).toEqual([]);
  });

  it("visitor act --action FILE", async () => {
    const box = await sandbox("act-file");
    await writeFile(path.join(box.project, "action.json"), JSON.stringify({ like: { postId: "post_42" } }));
    const doc = expectHumanExit(await runOpenStdin(["visitor", "act", "--action", "action.json"], box, visitorEnv), "CONFIRMATION_REQUIRED");
    expect(doc).toMatchObject({ data: { preview: { like: { postId: "post_42" } } } });
    expect(requests).toEqual([]);
  });

  it("visitor pending --retry", async () => {
    const box = await sandbox("pending-retry");
    const state: PendingState = {
      schemaVersion: 1,
      status: "pending",
      body: { like: { postId: "post_42" } } as PendingState["body"],
      agentId: AGENT,
      baseUrl: `${origin}/v1`,
      keyFingerprint: keyFingerprint(VISITOR_KEY),
      idempotencyKey: "action-11111111-2222-4333-8444-555555555555",
      createdAt: new Date().toISOString(),
    };
    await writeFile(path.join(box.project, ".arcopolis-pending.json"), serializePendingState(state), { mode: 0o600 });
    const doc = expectHumanExit(await runOpenStdin(["visitor", "pending", "--retry"], box, visitorEnv), "CONFIRMATION_REQUIRED");
    expect(doc).toMatchObject({ data: { pending: { action: "like" } } });
    expect(requests).toEqual([]);
  });

  it("auth import without --stdin (would need a hidden prompt)", async () => {
    const box = await sandbox("auth-import", { storedKey: false });
    expectHumanExit(await runOpenStdin(["auth", "import"], box), "INPUT_REQUIRED");
    expect(requests).toEqual([]);
  });

  it("auth forget without --yes", async () => {
    const box = await sandbox("auth-forget");
    expectHumanExit(await runOpenStdin(["auth", "forget"], box), "CONFIRMATION_REQUIRED");
    expect(requests).toEqual([]);
  });

  it("env write into a repository file that is not ignored, without --yes", async () => {
    const box = await sandbox("env-write");
    // Outside a repository there is no .gitignore to update, so env write writes (with a warning); inside one it must ask first.
    execFileSync("git", ["init", "-q"], { cwd: box.project, stdio: "ignore" });
    expectHumanExit(await runOpenStdin(["env", "write", ".env.arcopolis"], box), "CONFIRMATION_REQUIRED");
    expect(requests).toEqual([]);
  });

  it("setup with grants off (guided fallback): exit 10 after only the signup probe and the refused grant start", async () => {
    const box = await sandbox("setup", { storedKey: false });
    const doc = expectHumanExit(await runOpenStdin(["setup"], box), "HUMAN_SETUP_REQUIRED");
    expect(doc).toMatchObject({ humanAction: { mode: "guided" } });
    expect(requests).toEqual(["GET /_developer/signup", "POST /_developer/cli/grants"]);
  });

  it("setup with grants on: exit 10 APPROVAL_PENDING with the link and code after the probe and one grant start", async () => {
    grants = "enabled";
    const box = await sandbox("setup-grant", { storedKey: false });
    const doc = expectHumanExit(await runOpenStdin(["setup"], box), "APPROVAL_PENDING");
    expect(doc).toMatchObject({ humanAction: { userCode: "WDJB-MJHT", verificationUriComplete: "https://developers.arcologylabs.com/cli#code=WDJB-MJHT" } });
    expect(requests).toEqual(["GET /_developer/signup", "POST /_developer/cli/grants"]);
    expect((await stat(path.join(box.config, "pending-grant.json"))).mode & 0o777).toBe(0o600);
  });
});
