/**
 * MCP smoke (plan §8): spawns the built server (`node dist/bin.js mcp`) in
 * default and `--allow-writes` modes with the SDK's `Client` +
 * `StdioClientTransport`, against a loopback fake of the data plane and a
 * temp `ARCOPOLIS_CONFIG_DIR` holding fake stored keys. It asserts:
 *
 * - `listTools` returns the expected set with the plan's annotations;
 * - stdout carries only JSON-RPC (the client reports any other line, and a
 *   raw spawn parses every stdout line);
 * - a stored key never appears in any tool output or on stderr, even when
 *   the fake API echoes it back;
 * - diagnostics on stderr are JSON lines;
 * - everything finishes within 90 seconds.
 *
 * Run: `npm run build && npm run smoke:mcp`. No live network, no real keys.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { loadDemoFixtures } from "../src/core/demo.js";

type Json = Record<string, unknown>;

const DEADLINE_MS = 90_000;
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
const READ_KEY = `agnts_${"5".repeat(64)}`;
const VISITOR_KEY = `agnts_${"6".repeat(64)}`;
const AGENT = "visitor_smoke";
const KEY_SHAPE = /agnts_(?:[a-z]+_)*[0-9a-f]{16,}/;

/** Plan §6 table: [readOnly, destructive, idempotent, openWorld]. */
const PLAN_TOOLS: Record<string, [boolean, boolean, boolean, boolean]> = {
  arcopolis_status: [true, false, true, false],
  arcopolis_doctor: [true, false, true, true],
  arcopolis_operations: [true, false, true, false],
  arcopolis_read: [true, false, true, true],
  arcopolis_setup_start: [false, false, false, true],
  arcopolis_setup_finish: [false, false, true, true],
  arcopolis_visitor_status: [true, false, true, false],
  arcopolis_visitor_pending: [true, false, true, false],
  arcopolis_visitor_preview: [true, false, true, false],
  arcopolis_visitor_journal: [true, false, false, true],
  arcopolis_visitor_standing: [true, false, false, true],
};
const PLAN_WRITE_TOOLS: Record<string, [boolean, boolean, boolean, boolean]> = {
  arcopolis_visitor_heartbeat: [false, true, false, true],
  arcopolis_visitor_act: [false, true, false, true],
  arcopolis_visitor_retry_pending: [false, true, true, true],
};

const failures: string[] = [];
let checks = 0;

function check(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) failures.push(message);
}

function noKeys(label: string, value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  check(!text.includes(READ_KEY) && !text.includes(VISITOR_KEY) && !KEY_SHAPE.test(text), `${label}: a key-shaped secret appeared`);
}

/** Every non-empty stderr line is a `{phase, server:"arcopolis"}` JSON line (Node's own warnings excepted). */
function checkStderr(label: string, text: string): void {
  noKeys(`${label} stderr`, text);
  for (const line of text.split("\n")) {
    if (line.trim() === "" || /ExperimentalWarning|--trace-warnings/.test(line)) continue;
    let parsed: Json | null = null;
    try {
      parsed = JSON.parse(line) as Json;
    } catch {
      parsed = null;
    }
    check(parsed !== null && parsed.server === "arcopolis" && typeof parsed.phase === "string", `${label}: stderr line is not a JSON diagnostic: ${line.slice(0, 120)}`);
  }
}

interface FakeApi {
  origin: string;
  requests: Array<{ method: string; path: string; key: string | undefined }>;
  close(): Promise<void>;
}

/** Loopback fake of the data plane that echoes both keys back in every body. */
async function startFakeApi(): Promise<FakeApi> {
  const fixtures = await loadDemoFixtures();
  const requests: FakeApi["requests"] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    request.resume();
    request.on("end", () => {
      const key = typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : undefined;
      requests.push({ method: request.method ?? "GET", path: url.pathname, key });
      const reply = (status: number, body: unknown): void => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.method === "GET" && url.pathname === "/v1/agents") {
        reply(200, {
          data: [{ id: "agent_smoke", handle: "@smoke", bio: `echo ${READ_KEY} and ${VISITOR_KEY}`, [READ_KEY]: "as a property name" }],
          meta: { page: 1, perPage: 20, total: 1, hasMore: false },
        });
        return;
      }
      if (request.method === "POST" && url.pathname === `/v1/visitors/${AGENT}/heartbeat`) {
        const envelope = structuredClone(fixtures.starter.heartbeat) as { data: Json };
        envelope.data = {
          ...envelope.data,
          agentId: AGENT,
          heartbeatAt: new Date().toISOString(),
          previousHeartbeatAt: null,
          feed: [{ postId: "post_1", authorHandle: "nova", text: `my key ${VISITOR_KEY}` }],
        };
        reply(200, envelope);
        return;
      }
      reply(404, { error: { code: "NOT_FOUND", message: "Endpoint not found" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Temp store (0700) with fake read and visitor keys bound to the fake API origin (0600). */
async function prepareStore(root: string, origin: string): Promise<{ cfg: string; project: string }> {
  const cfg = path.join(root, "cfg");
  const project = path.join(root, "project");
  await mkdir(cfg, { recursive: true, mode: 0o700 });
  await chmod(cfg, 0o700);
  await mkdir(project, { recursive: true });
  const savedAt = new Date().toISOString();
  const file = path.join(cfg, "credentials.json");
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      profiles: {
        default: {
          source: "import",
          readKey: { key: READ_KEY, tier: 3, origin, savedAt, lastVerifiedAt: savedAt },
          visitor: { agentId: AGENT, key: VISITOR_KEY, origin, savedAt, lastVerifiedAt: savedAt },
        },
      },
    }),
  );
  await chmod(file, 0o600);
  return { cfg, project };
}

interface ToolOutcome {
  isError: boolean;
  structured: Json;
  raw: unknown;
}

/** One client session over `node dist/bin.js mcp …`. */
async function session(
  label: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  body: (callTool: (name: string, input?: Json) => Promise<ToolOutcome>, tools: Array<{ name: string; annotations?: Json }>) => Promise<void>,
): Promise<void> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp", ...args], env, cwd, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const transportErrors: string[] = [];
  transport.onerror = (error: Error): void => {
    transportErrors.push(error.message);
  };
  const client = new Client({ name: "arcopolis-smoke", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const callTool = async (name: string, input: Json = {}): Promise<ToolOutcome> => {
      const result = (await client.callTool({ name, arguments: input })) as Json;
      noKeys(`${label} ${name}`, result);
      return { isError: result.isError === true, structured: (result.structuredContent ?? {}) as Json, raw: result };
    };
    await body(callTool, tools as Array<{ name: string; annotations?: Json }>);
  } finally {
    await client.close();
  }
  check(transportErrors.length === 0, `${label}: non-JSON-RPC output or transport error: ${transportErrors.join("; ")}`);
  checkStderr(label, stderr);
}

function checkTools(label: string, tools: Array<{ name: string; annotations?: Json }>, expected: Record<string, [boolean, boolean, boolean, boolean]>): void {
  const names = tools.map((tool) => tool.name);
  check(JSON.stringify(names) === JSON.stringify(Object.keys(expected)), `${label}: tools ${names.join(",")} != ${Object.keys(expected).join(",")}`);
  for (const tool of tools) {
    const [readOnlyHint, destructiveHint, idempotentHint, openWorldHint] = expected[tool.name] ?? [];
    const want = JSON.stringify({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint });
    check(JSON.stringify(tool.annotations) === want, `${label}: ${tool.name} annotations ${JSON.stringify(tool.annotations)} != ${want}`);
  }
}

/** Raw spawn: every stdout line must parse as a JSON-RPC 2.0 message, and the process must exit 0 on stdin end. */
async function rawStdoutCheck(env: Record<string, string>, cwd: string): Promise<void> {
  const child = spawn(process.execPath, [BIN, "mcp"], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const send = (message: Json): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const waitFor = async (id: number): Promise<void> => {
    const started = Date.now();
    while (!stdout.split("\n").some((line) => line.includes(`"id":${id}`))) {
      if (Date.now() - started > 30_000) throw new Error(`raw: no response ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "raw", version: "0" } } });
  await waitFor(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "arcopolis_read", arguments: { operationId: "listAgents" } } });
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "arcopolis_status", arguments: {} } });
  await waitFor(2);
  await waitFor(3);
  await waitFor(4);
  child.stdin.end();
  const code = await exited;
  check(code === 0, `raw: exit code ${String(code)}`);
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  check(lines.length === 4, `raw: expected 4 JSON-RPC responses, got ${lines.length}`);
  for (const line of lines) {
    let message: Json | null = null;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      message = null;
    }
    check(message !== null && message.jsonrpc === "2.0", `raw: stdout line is not JSON-RPC: ${line.slice(0, 120)}`);
  }
  noKeys("raw stdout", stdout);
  checkStderr("raw", stderr);
}

async function main(): Promise<number> {
  if (!existsSync(BIN)) {
    process.stderr.write(`smoke-mcp: ${BIN} is missing; run npm run build first.\n`);
    return 1;
  }
  const started = Date.now();
  const root = await mkdtemp(path.join(os.tmpdir(), "arcopolis-smoke-mcp-"));
  const api = await startFakeApi();
  try {
    const { cfg, project } = await prepareStore(root, api.origin);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: root,
      ARCOPOLIS_CONFIG_DIR: cfg,
      ARCOPOLIS_API_BASE: `${api.origin}/v1`,
      // The control plane is the loopback fake too, so no setup tool can reach the live portal.
      ARCOPOLIS_DEVELOPER_BASE: `${api.origin}/_developer`,
    };

    await session("default", [], env, project, async (callTool, tools) => {
      checkTools("default", tools, PLAN_TOOLS);
      for (const name of ["arcopolis_status", "arcopolis_doctor", "arcopolis_operations", "arcopolis_visitor_status", "arcopolis_visitor_pending"]) {
        const outcome = await callTool(name);
        check(!outcome.isError && outcome.structured.ok === true && outcome.structured.command === name, `default: ${name} failed: ${JSON.stringify(outcome.structured).slice(0, 300)}`);
      }
      const read = await callTool("arcopolis_read", { operationId: "listAgents" });
      check(!read.isError && read.structured.ok === true, `default: arcopolis_read failed: ${JSON.stringify(read.structured).slice(0, 300)}`);
      check(typeof read.structured.untrusted === "object", "default: arcopolis_read has no untrusted block");
      const preview = await callTool("arcopolis_visitor_preview", { action: { like: { postId: "post_1" } } });
      check(!preview.isError && /^[0-9a-f]{64}$/.test(String((preview.structured.data as Json | undefined)?.previewDigest)), "default: preview has no previewDigest");
      const before = api.requests.length;
      const setup = await callTool("arcopolis_setup_start");
      check(!setup.isError && (setup.structured.data as Json | undefined)?.status === "configured", `default: setup_start with verified keys was not "configured": ${JSON.stringify(setup.structured).slice(0, 300)}`);
      check(api.requests.length === before, "default: setup_start with verified keys sent a request");
      const finish = await callTool("arcopolis_setup_finish");
      check(finish.isError && (finish.structured.error as Json | undefined)?.code === "GRANT_NOT_STARTED", "default: setup_finish with nothing pending was not GRANT_NOT_STARTED");
      const tooMany = await callTool("arcopolis_read", { operationId: "listAgents", maxPages: 6 });
      check(tooMany.isError && (tooMany.structured.error as Json | undefined)?.code === "INVALID_FLAG_VALUE", "default: maxPages 6 was not INVALID_FLAG_VALUE");
    });
    const readRequests = api.requests.filter((request) => request.path === "/v1/agents");
    check(readRequests.length === 1 && readRequests[0]?.key === READ_KEY, "default: the stored read key did not reach the loopback API exactly once");

    await session("allow-writes", ["--allow-writes"], env, project, async (callTool, tools) => {
      checkTools("allow-writes", tools, { ...PLAN_TOOLS, ...PLAN_WRITE_TOOLS });
      const first = await callTool("arcopolis_visitor_heartbeat", { confirm: true });
      check(!first.isError && first.structured.ok === true, `allow-writes: heartbeat failed: ${JSON.stringify(first.structured).slice(0, 300)}`);
      const second = await callTool("arcopolis_visitor_heartbeat", { confirm: true });
      check(second.isError && (second.structured.error as Json | undefined)?.code === "LOCAL_CADENCE_GUARD", "allow-writes: second heartbeat was not LOCAL_CADENCE_GUARD");
      const digest = "0".repeat(64);
      const act = await callTool("arcopolis_visitor_act", { action: { like: { postId: "post_1" } }, previewDigest: digest });
      check(act.isError && (act.structured.error as Json | undefined)?.code === "PREVIEW_DIGEST_MISMATCH", "allow-writes: a wrong previewDigest was not refused");
    });
    const heartbeats = api.requests.filter((request) => request.path.endsWith("/heartbeat"));
    check(heartbeats.length === 1 && heartbeats[0]?.key === VISITOR_KEY, "allow-writes: expected exactly one heartbeat with the stored visitor key");
    check(!api.requests.some((request) => request.path.endsWith("/act")), "allow-writes: an act request was sent");

    await rawStdoutCheck(env, project);

    const elapsed = Date.now() - started;
    check(elapsed < DEADLINE_MS, `took ${elapsed} ms (limit ${DEADLINE_MS})`);
    process.stdout.write(`smoke-mcp: ${checks - failures.length}/${checks} checks passed in ${(elapsed / 1000).toFixed(1)} s\n`);
  } finally {
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
  for (const failure of failures) process.stderr.write(`smoke-mcp FAIL: ${failure}\n`);
  return failures.length === 0 ? 0 : 1;
}

const deadline = setTimeout(() => {
  process.stderr.write(`smoke-mcp FAIL: did not finish within ${DEADLINE_MS / 1000} s\n`);
  process.exit(1);
}, DEADLINE_MS);

main()
  .then((code) => {
    clearTimeout(deadline);
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    clearTimeout(deadline);
    process.stderr.write(`smoke-mcp FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
