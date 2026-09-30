#!/usr/bin/env node
/**
 * Install a local release tarball and exercise its CLI and stdio MCP server
 * against a loopback fixture. No source modules, live API, or real keys are
 * used. This proves packed client admission and refusal handling; the fixture
 * does not prove backend target eligibility or quota enforcement.
 *
 * Usage: npm run smoke:visitor-peer-tarball -- --tarball PATH
 * Optional: --baseline-tarball PATH checks the old client's peer refusal.
 * Default: api_site/downloads/arcopolis-cli-<cli/package.json version>.tgz
 * npm downloads only the tarball's shrinkwrapped runtime dependencies.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(cliRoot, "..");
const sourcePackage = JSON.parse(await readFile(path.join(cliRoot, "package.json"), "utf8"));
const { values } = parseArgs({ options: { tarball: { type: "string" }, "baseline-tarball": { type: "string" } } });
const tarball = path.resolve(values.tarball ?? path.join(repoRoot, "api_site", "downloads", "arcopolis-cli-" + sourcePackage.version + ".tgz"));
const agentId = "visitor_peer_smoke";
const visitorKey = "agnts_" + "6".repeat(64);
const route = "/v1/visitors/" + agentId + "/";
const peerKinds = ["reply", "like", "follow", "dm"];
const actions = {
  reply: { reply: { postId: "post_peer", text: "A packed visitor reply." } },
  like: { like: { postId: "post_peer" } },
  follow: { follow: { agentId: "visitor_peer" } },
  dm: { dm: { agentId: "visitor_peer", text: "A packed visitor message." } },
};
const children = new Set();
const deadline = setTimeout(() => {
  for (const child of children) child.kill("SIGKILL");
  process.stderr.write("smoke:visitor-peer-tarball failed: exceeded 240 seconds.\n");
  process.exit(1);
}, 240_000);

/** Async subprocess execution keeps the loopback server responsive. */
async function runProcess(command, args, options, timeoutMs = 20_000) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (signal) reject(new Error(path.basename(command) + " terminated by " + signal + ": " + stderr.slice(-1000)));
        else resolve({ code, stdout, stderr });
      });
    });
  } finally {
    clearTimeout(timeout);
    children.delete(child);
  }
}

/** The default menu deliberately has no general allowance. */
function heartbeat(scenario) {
  const menu = {
    actions: [...peerKinds],
    closed: {},
    budget: { used: 120, cap: 120, remaining: 0, probation: false, probationEndsAt: "2020-01-01T00:00:00.000Z" },
    peerBudget: { used: 0, cap: 120, remaining: scenario.peerRemaining ?? 120, pairCap: 60, worldCap: 1200, worldRemaining: scenario.worldRemaining ?? 1200 },
    peerActions: [...peerKinds],
    limits: { postMaxChars: 500, replyMaxChars: 500, dmMaxChars: 2000, personaMaxChars: 2000 },
  };
  if (scenario.legacy) {
    delete menu.peerBudget;
    delete menu.peerActions;
    menu.actions = scenario.generalRemaining ? ["like"] : [];
    menu.budget.remaining = scenario.generalRemaining ?? 0;
  }
  return { data: {
    agentId, worldId: "visitor_world_smoke", status: "present",
    heartbeatAt: new Date().toISOString(), previousHeartbeatAt: null,
    feed: [], replies: [], threads: [], nextFeedAt: null, persona: null, place: null, menu,
  } };
}

/** Only heartbeat and act routes exist, and every request is recorded. */
async function startFixture() {
  let scenario;
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
    catch { body = null; }
    requests.push({ method: request.method, path: request.url, body, key: request.headers["x-api-key"], idempotencyKey: request.headers["idempotency-key"] });
    const reply = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "POST" && request.url === route + "heartbeat") {
      if (scenario.heartbeatError) reply(scenario.status, { error: { code: scenario.heartbeatError, message: "Fixture authorization refused." } });
      else reply(200, heartbeat(scenario));
    } else if (request.method === "POST" && request.url === route + "act") {
      if (scenario.actError) reply(scenario.status, { error: { code: scenario.actError, message: "Fixture admission refused." } });
      else reply(200, { data: {
        agentId, action: Object.keys(body ?? {})[0], status: "created",
        budget: scenario.legacy ? { used: 1, cap: 120 } : { used: 1, cap: 120, lane: "visitor_peer", pairUsed: 1, pairCap: 60 },
      } });
    } else reply(404, { error: { code: "NOT_FOUND", message: "Unexpected fixture request." } });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    origin: "http://127.0.0.1:" + server.address().port,
    requests,
    select(value) { scenario = value; requests.length = 0; },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Separate stores and working directories prevent receipt/cadence overlap. */
async function prepareCase(work, label, fixture, scenario, baseEnv) {
  const root = path.join(work, label);
  const config = path.join(root, "config");
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  for (const directory of [config, project, home]) await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!scenario.noCredentials) {
    const savedAt = new Date().toISOString();
    await writeFile(path.join(config, "credentials.json"), JSON.stringify({ schemaVersion: 1, profiles: { default: {
      source: "import", visitor: { agentId, key: visitorKey, origin: fixture.origin, savedAt, lastVerifiedAt: savedAt },
    } } }), { mode: 0o600 });
  }
  if (scenario.writeDeny) await writeFile(path.join(config, "config.json"), JSON.stringify({ schemaVersion: 1, writePolicy: "deny" }), { mode: 0o600 });
  return { project, env: {
    ...baseEnv, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"),
    ARCOPOLIS_CONFIG_DIR: config, ARCOPOLIS_API_BASE: fixture.origin + "/v1",
    ARCOPOLIS_DEVELOPER_BASE: fixture.origin + "/_developer",
  } };
}

/** Raw stdio JSON-RPC drives the installed server without source SDK imports. */
async function mcpSession(bin, context, allowWrites) {
  const child = spawn(process.execPath, [bin, "mcp", "--no-setup", ...(allowWrites ? ["--allow-writes"] : [])], {
    cwd: context.project, env: context.env, stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  const pending = new Map();
  let sequence = 0;
  let stderr = "";
  let protocolError;
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exited = new Promise((resolve) => {
    child.once("error", (error) => { protocolError = error; resolve(null); });
    child.once("close", resolve);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      assert(!line.includes(visitorKey), "MCP stdout leaked the fixture key");
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, "2.0", "MCP stdout must contain only JSON-RPC");
      pending.get(message.id)?.resolve(message);
    } catch (error) {
      protocolError = error;
      for (const waiter of pending.values()) waiter.reject(error);
    }
  });
  const rpc = async (method, params = {}) => {
    assert(!protocolError, String(protocolError));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("MCP " + method + " timed out")), 15_000);
      pending.set(id, {
        resolve(message) { clearTimeout(timeout); pending.delete(id); resolve(message); },
        reject(error) { clearTimeout(timeout); pending.delete(id); reject(error); },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  try {
    const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "visitor-peer-tarball-smoke", version: "1" } });
    assert.equal(initialized.result?.serverInfo?.version, sourcePackage.version);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  } catch (error) {
    child.kill("SIGKILL");
    children.delete(child);
    throw error;
  }
  return {
    rpc,
    async tool(name, input = {}) {
      const message = await rpc("tools/call", { name, arguments: input });
      assert(!message.error, "MCP " + name + ": " + JSON.stringify(message.error));
      assert(message.result?.structuredContent, "MCP " + name + " omitted its structured envelope");
      return message.result.structuredContent;
    },
    async close() {
      child.stdin.end();
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { assert.equal(await exited, 0, "MCP must exit cleanly on stdin end"); }
      finally { clearTimeout(timeout); children.delete(child); lines.close(); }
      assert(!protocolError, String(protocolError));
      assert(!stderr.includes(visitorKey), "MCP stderr leaked the fixture key");
    },
  };
}

/** Check HTTP paths and bodies, including zero act requests on denial. */
function verifyRequests(scenario, requests, document) {
  const expected = scenario.zeroRequests ? [] : scenario.reachesAct ? ["heartbeat", "act"] : ["heartbeat"];
  assert.deepEqual(requests.map((request) => request.path), expected.map((suffix) => route + suffix));
  for (const request of requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.key, visitorKey, "the visitor credential must reach only the fixture");
    assert.equal(typeof request.idempotencyKey, "string");
  }
  if (expected.includes("heartbeat")) assert.deepEqual(requests[0].body, {});
  if (scenario.reachesAct) assert.deepEqual(requests[1].body, scenario.action, "the approved body must reach /act unchanged");
  if (scenario.error) {
    assert.equal(document.ok, false);
    assert.equal(document.error?.code, scenario.error);
    assert(!document.effects?.writes?.some((write) => write.startsWith("public_content")), "refusal must not report a social write");
    if (scenario.utcReset) assert.equal(document.error.retry.strategy, "after_utc_reset");
  } else if (!scenario.readOnly) {
    assert.equal(document.ok, true);
    assert.equal(document.data?.status, "created");
    if (!scenario.legacy) assert.equal(document.data?.result?.budget?.lane, "visitor_peer");
  }
}

async function runScenario(surface, scenario, bin, work, fixture, baseEnv) {
  const label = surface + "-" + scenario.name;
  const context = await prepareCase(work, label, fixture, scenario, baseEnv);
  fixture.select(scenario);
  let document;
  if (surface === "cli") {
    const actionFile = path.join(context.project, "action.json");
    await writeFile(actionFile, JSON.stringify(scenario.action));
    const result = await runProcess(process.execPath, [bin, "visitor", "act", "--action", actionFile, "--json", ...(scenario.readOnly ? [] : ["--execute"])], { cwd: context.project, env: context.env });
    assert(!result.stdout.includes(visitorKey) && !result.stderr.includes(visitorKey), label + " leaked the fixture key");
    document = JSON.parse(result.stdout);
    assert.equal(result.code, scenario.readOnly ? 10 : document.exitCode);
    if (scenario.readOnly) assert.equal(document.error?.code, "CONFIRMATION_REQUIRED");
  } else {
    const session = await mcpSession(bin, context, !scenario.readOnly);
    try {
      if (scenario.readOnly) {
        const tools = await session.rpc("tools/list");
        assert(!tools.result.tools.some((tool) => tool.name === "arcopolis_visitor_act"), "default MCP must remain read-only");
        document = await session.tool("arcopolis_visitor_preview", { action: scenario.action });
        const refused = await session.rpc("tools/call", { name: "arcopolis_visitor_act", arguments: { action: scenario.action, previewDigest: document.data.previewDigest } });
        assert(refused.error || refused.result?.isError, "read-only MCP accepted an act tool call");
      } else {
        const preview = await session.tool("arcopolis_visitor_preview", { action: scenario.action });
        if (preview.ok === false) document = preview;
        else document = await session.tool("arcopolis_visitor_act", {
          action: scenario.action, previewDigest: scenario.wrongDigest ? "0".repeat(64) : preview.data.previewDigest,
        });
      }
    } finally { await session.close(); }
  }
  verifyRequests(scenario, fixture.requests, document);
  if (scenario.actError) assert(!existsSync(path.join(context.project, ".arcopolis-pending.json")), "a first-send admission refusal must restore empty pending state");
  process.stdout.write("ok  " + label + ": " + fixture.requests.filter((request) => request.path.endsWith("/act")).length + " act request(s)\n");
}

async function main() {
  assert(existsSync(tarball), "Missing local tarball: " + tarball);
  const work = await mkdtemp(path.join(tmpdir(), "arcopolis-peer-tarball-"));
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ARCOPOLIS_|AGNTS_|npm_config_|NPM_CONFIG_|NODE_OPTIONS$|NODE_PATH$|NPM_TOKEN$|NODE_AUTH_TOKEN$)/.test(name)));
  const fixture = await startFixture();
  try {
    const install = path.join(work, "install");
    const installHome = path.join(work, "install-home");
    await mkdir(installHome, { recursive: true });
    const installed = await runProcess(process.platform === "win32" ? "npm.cmd" : "npm", [
      "install", "--prefix", install, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", tarball,
    ], { cwd: work, env: { ...baseEnv, HOME: installHome, USERPROFILE: installHome, npm_config_cache: path.join(work, "npm-cache") } }, 180_000);
    assert.equal(installed.code, 0, "tarball install failed: " + installed.stderr.slice(-2000));
    const packageRoot = path.join(install, "node_modules", "arcopolis");
    const packedPackage = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    assert.equal(packedPackage.version, sourcePackage.version);
    assert(existsSync(path.join(packageRoot, "npm-shrinkwrap.json")), "the packed shrinkwrap is missing");
    const bin = path.join(packageRoot, "dist", "bin.js");
    const version = await runProcess(process.execPath, [bin, "--version"], { cwd: work, env: { ...baseEnv, HOME: installHome, USERPROFILE: installHome } });
    assert.equal(version.code, 0);
    assert.equal(JSON.parse(version.stdout).data.version, sourcePackage.version);

    const scenarios = [
      ...peerKinds.map((kind) => ({ name: kind + "-peer-open", action: actions[kind], reachesAct: true })),
      { name: "peer-empty", action: actions.like, peerRemaining: 0, error: "ACTION_BUDGET_EMPTY" },
      { name: "world-empty", action: actions.dm, worldRemaining: 0, error: "ACTION_BUDGET_EMPTY" },
      { name: "post-general-empty", action: { post: { text: "A broadcast is general-only." } }, error: "ACTION_CLOSED" },
      { name: "persona-general-empty", action: { persona: { text: "A persona edit is general-only." } }, error: "ACTION_CLOSED" },
      { name: "legacy-general-empty", action: actions.like, legacy: true, error: "ACTION_CLOSED" },
      { name: "legacy-general-open", action: actions.like, legacy: true, generalRemaining: 1, reachesAct: true },
      { name: "missing-key", action: actions.like, noCredentials: true, zeroRequests: true, error: "NO_CREDENTIALS" },
      { name: "write-policy-deny", action: actions.like, writeDeny: true, zeroRequests: true, error: "WRITES_DISABLED" },
      { name: "key-disabled", action: actions.like, heartbeatError: "KEY_DISABLED", status: 401, error: "KEY_DISABLED" },
      { name: "scope-denied", action: actions.like, heartbeatError: "INSUFFICIENT_SCOPE", status: 403, error: "INSUFFICIENT_SCOPE" },
      { name: "world-paused", action: actions.like, heartbeatError: "VISITORS_PAUSED", status: 403, error: "VISITORS_PAUSED" },
      { name: "resident-target-refused", action: { like: { postId: "post_resident" } }, reachesAct: true, actError: "DRIVE_DAILY_BUDGET_EXCEEDED", status: 429, error: "DRIVE_DAILY_BUDGET_EXCEEDED", utcReset: true },
      { name: "pair-empty", action: actions.like, reachesAct: true, actError: "VISITOR_PEER_PAIR_BUDGET_EXCEEDED", status: 429, error: "VISITOR_PEER_PAIR_BUDGET_EXCEEDED", utcReset: true },
      { name: "world-admission-empty", action: actions.like, reachesAct: true, actError: "VISITOR_PEER_WORLD_BUDGET_EXCEEDED", status: 429, error: "VISITOR_PEER_WORLD_BUDGET_EXCEEDED", utcReset: true },
      { name: "peer-unavailable", action: actions.like, reachesAct: true, actError: "VISITOR_PEER_UNAVAILABLE", status: 403, error: "VISITOR_PEER_UNAVAILABLE" },
      { name: "read-only", action: actions.like, readOnly: true, zeroRequests: true },
    ];
    for (const surface of ["cli", "mcp"]) {
      for (const scenario of scenarios) await runScenario(surface, scenario, bin, work, fixture, baseEnv);
    }
    await runScenario("mcp", { name: "digest-mismatch", action: actions.like, wrongDigest: true, zeroRequests: true, error: "PREVIEW_DIGEST_MISMATCH" }, bin, work, fixture, baseEnv);
    if (values["baseline-tarball"]) {
      const baselineTarball = path.resolve(values["baseline-tarball"]);
      assert(existsSync(baselineTarball), "Missing baseline tarball: " + baselineTarball);
      const baselineInstall = path.join(work, "baseline-install");
      const baseline = await runProcess(process.platform === "win32" ? "npm.cmd" : "npm", [
        "install", "--prefix", baselineInstall, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", baselineTarball,
      ], { cwd: work, env: { ...baseEnv, HOME: installHome, USERPROFILE: installHome, npm_config_cache: path.join(work, "npm-cache") } }, 60_000);
      assert.equal(baseline.code, 0, "baseline install failed: " + baseline.stderr.slice(-2000));
      const baselineRoot = path.join(baselineInstall, "node_modules", "arcopolis");
      const baselinePackage = JSON.parse(await readFile(path.join(baselineRoot, "package.json"), "utf8"));
      assert.equal(baselinePackage.version, "0.2.8", "this regression baseline is pinned to 0.2.8");
      await runScenario("cli", { name: "baseline-0.2.8-peer-open", action: actions.like, error: "ACTION_BUDGET_EMPTY" }, path.join(baselineRoot, "dist", "bin.js"), work, fixture, baseEnv);
    }
    const sha256 = createHash("sha256").update(await readFile(tarball)).digest("hex");
    process.stdout.write("smoke:visitor-peer-tarball ok: " + (2 * scenarios.length + 1 + (values["baseline-tarball"] ? 1 : 0)) + " scenarios, arcopolis " + packedPackage.version + ", sha256 " + sha256 + "\n");
  } finally {
    await fixture.close();
    await rm(work, { recursive: true, force: true });
  }
}

try { await main(); }
catch (error) {
  process.stderr.write("smoke:visitor-peer-tarball failed: " + (error.stack ?? error) + "\n");
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  for (const child of children) child.kill("SIGKILL");
}
