/**
 * `--demo` end to end for every registered command (plan §3.7 and §8). Each
 * command runs as a real `node dist/bin.js <command> --demo --json` process,
 * with a preload that records and refuses every fetch and socket connect,
 * a temp HOME, project directory, and ARCOPOLIS_CONFIG_DIR, and a fake key
 * in the environment that demo mode must ignore.
 *
 * Every run must print exactly one JSON document (schemaVersion 1) with a
 * documented exit code, make no network request, write no file, and print
 * no key material. Write commands run without --execute. `mcp` is the one
 * command whose stdout is JSON-RPC instead of a document; it gets its own
 * case below.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMANDS } from "../src/cli/registry.js";
import { GLOBAL_FLAGS } from "../src/cli/spec.js";
import { DEMO_READ_KEY, DEMO_VISITOR_KEY } from "../src/core/demo.js";
import { CLI_ROOT, RAW_KEY_PATTERN, builtBin, childEnv, fakeKey, spawnCli, tempDir, type ProcessResult } from "./helpers.js";

const NO_NETWORK = pathToFileURL(path.join(CLI_ROOT, "test", "fixtures", "no-network.mjs")).href;
const ENV_KEY = fakeKey("e");
const KILL_AFTER_MS = 30_000;

/** Arguments after `--demo --json` for each command, and the exit code the demo run must produce. */
const DEMO_CASES: Record<string, { args: string[]; exit: number; code?: string }> = {
  status: { args: [], exit: 0 },
  doctor: { args: [], exit: 0 },
  setup: { args: [], exit: 0 },
  "auth status": { args: [], exit: 0 },
  // No --stdin and no TTY: the hidden prompt cannot run.
  "auth import": { args: [], exit: 10, code: "INPUT_REQUIRED" },
  "auth forget": { args: [], exit: 0 },
  init: { args: [], exit: 0 },
  schema: { args: [], exit: 0 },
  version: { args: ["--check"], exit: 0 },
  portal: { args: [], exit: 0 },
  "api ops": { args: [], exit: 0 },
  "api get": { args: ["/v1/trending"], exit: 0 },
  "agents list": { args: ["--per-page", "5"], exit: 0 },
  "agents get": { args: ["agent_1"], exit: 0 },
  "agents posts": { args: ["agent_1"], exit: 0 },
  "agents memory": { args: ["agent_1"], exit: 0 },
  "agents mood": { args: ["agent_1"], exit: 0 },
  "agents relationships": { args: ["agent_1"], exit: 0 },
  "agents reputation": { args: ["agent_1"], exit: 0 },
  "agents signals": { args: ["agent_1"], exit: 0 },
  "agents thoughts": { args: ["agent_1"], exit: 0 },
  "agents topics": { args: ["agent_1"], exit: 0 },
  "posts list": { args: [], exit: 0 },
  "posts get": { args: ["post_1"], exit: 0 },
  "posts replies": { args: ["post_1"], exit: 0 },
  trending: { args: [], exit: 0 },
  search: { args: ["hello"], exit: 0 },
  "topics list": { args: [], exit: 0 },
  "topics timeline": { args: ["topic_1", "--days", "7"], exit: 0 },
  "network graph": { args: ["--allow-expensive"], exit: 0 },
  "network ideas": { args: [], exit: 0 },
  "network challenges": { args: [], exit: 0 },
  "visitor status": { args: [], exit: 0 },
  "visitor heartbeat": { args: [], exit: 10, code: "CONFIRMATION_REQUIRED" },
  "visitor act": { args: ["--like", "post_1"], exit: 10, code: "CONFIRMATION_REQUIRED" },
  "visitor pending": { args: [], exit: 0 },
  "visitor journal": { args: [], exit: 0 },
  "visitor standing": { args: [], exit: 0 },
  exec: { args: ["--", "node", "-e", "process.exit(3)"], exit: 0 },
  "env write": { args: [".env.arcopolis"], exit: 0 },
  "env status": { args: [], exit: 0 },
};

/** Files present in the project before each run; the run must leave them byte-identical. */
const PROJECT_SEED: Record<string, string> = {
  "AGENTS.md": "# Agents\n\nHand-written instructions.\n",
  ".gitignore": "node_modules/\n",
  "app.mjs": "console.log('hello');\n",
};

let root: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  builtBin();
  ({ dir: root, cleanup } = await tempDir("arcopolis-demo-e2e-"));
});

afterAll(async () => {
  await cleanup();
});

/** Every file under `dir` with its contents, keyed by relative path. */
async function snapshotTree(dir: string, prefix = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await snapshotTree(full, relative), { [`${relative}/`]: "<dir>" });
    else out[relative] = await readFile(full, "utf8");
  }
  return out;
}

/** A fresh sandbox for one command: HOME, config dir, project dir, and a network log path. */
async function sandbox(name: string): Promise<{ home: string; config: string; project: string; networkLog: string }> {
  const base = path.join(root, name.replace(/\s+/g, "-"));
  const home = path.join(base, "home");
  const config = path.join(base, "config");
  const project = path.join(base, "project");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(config, { recursive: true, mode: 0o700 }), mkdir(project, { recursive: true })]);
  for (const [file, content] of Object.entries(PROJECT_SEED)) await writeFile(path.join(project, file), content);
  return { home, config, project, networkLog: path.join(base, "network.log") };
}

function demoEnv(box: { home: string; config: string; networkLog: string }): Record<string, string> {
  return childEnv({
    HOME: box.home,
    XDG_CONFIG_HOME: path.join(box.home, ".config"),
    ARCOPOLIS_CONFIG_DIR: box.config,
    ARCOPOLIS_TEST_NETWORK_LOG: box.networkLog,
    // Demo mode must ignore real keys and bases from the environment.
    ARCOPOLIS_API_KEY: ENV_KEY,
    ARCOPOLIS_VISITOR_API_KEY: ENV_KEY,
    ARCOPOLIS_API_BASE: "http://127.0.0.1:9/v1",
  });
}

function assertNoKeyMaterial(result: ProcessResult): void {
  const output = `${result.stdout}\n${result.stderr}`;
  expect(output).not.toMatch(RAW_KEY_PATTERN);
  for (const key of [ENV_KEY, DEMO_READ_KEY, DEMO_VISITOR_KEY]) expect(output.includes(key)).toBe(false);
}

function assertNoNetwork(networkLog: string): void {
  const attempts = existsSync(networkLog) ? readFileSync(networkLog, "utf8").trim() : "";
  expect(attempts, "network attempts recorded by the preload").toBe("");
}

describe("--demo end to end for every command (dist/bin.js)", () => {
  it("covers every registered command except mcp, and nothing else", () => {
    const registered = COMMANDS.map((spec) => spec.name).filter((name) => name !== "mcp").sort();
    expect(Object.keys(DEMO_CASES).sort()).toEqual(registered);
  });

  const specs = COMMANDS.filter((spec) => spec.name !== "mcp");
  it.concurrent.each(specs.map((spec) => [spec.name, spec] as const))(
    "%s",
    { timeout: KILL_AFTER_MS + 10_000 },
    async (name, spec) => {
      const demoCase = DEMO_CASES[name];
      expect(demoCase, `add a DEMO_CASES entry for "${name}"`).toBeDefined();
      if (!demoCase) return;
      const box = await sandbox(name);
      const result = await spawnCli([...name.split(" "), "--demo", "--json", ...demoCase.args], {
        cwd: box.project,
        env: demoEnv(box),
        nodeArgs: ["--import", NO_NETWORK],
        killAfterMs: KILL_AFTER_MS,
      });
      expect(result.killed, result.stderr).toBe(false);

      const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");
      expect(lines, `stdout of ${name}; stderr: ${result.stderr}`).toHaveLength(1);
      const doc = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
      expect(doc).toMatchObject({ schemaVersion: 1, command: name, exitCode: result.exitCode, ok: result.exitCode === 0 });
      expect(spec.exitCodes, `${name} exit ${String(result.exitCode)} is not in its documented exitCodes`).toContain(result.exitCode);
      expect(result.exitCode, JSON.stringify(doc)).toBe(demoCase.exit);
      if (demoCase.code) expect(doc).toMatchObject({ error: { code: demoCase.code } });
      if (result.exitCode === 0) {
        expect(doc).toMatchObject({ meta: { demo: true }, effects: { requests: 0, network: [], writes: [], secretsWritten: [] } });
      }

      assertNoNetwork(box.networkLog);
      assertNoKeyMaterial(result);
      expect(await snapshotTree(box.home), "files written under HOME").toEqual({});
      expect(await snapshotTree(box.config), "files written in ARCOPOLIS_CONFIG_DIR (demo writes none)").toEqual({});
      expect(await snapshotTree(box.project), "project files changed").toEqual(PROJECT_SEED);
    },
  );

  it("no flag is one Node reads even after the script path (--env-file), so every flag reaches the CLI", () => {
    const nodeScanned = ["env-file", "env-file-if-exists"];
    const names = [...GLOBAL_FLAGS, ...COMMANDS.flatMap((spec) => spec.flags)].map((flag) => flag.name);
    for (const name of nodeScanned) expect(names, `--${name} would be intercepted by node itself`).not.toContain(name);
  });

  it("setup --write-env-file with a file that does not exist yet prints one JSON document (dist/bin.js)", { timeout: KILL_AFTER_MS + 10_000 }, async () => {
    const box = await sandbox("setup-write-env-file");
    for (const args of [["--write-env-file", ".env.new"], ["--write-env-file=.env.new"]]) {
      const result = await spawnCli(["setup", ...args, "--demo", "--json"], {
        cwd: box.project,
        env: demoEnv(box),
        nodeArgs: ["--import", NO_NETWORK],
        killAfterMs: KILL_AFTER_MS,
      });
      expect(result.killed, result.stderr).toBe(false);
      expect(result.stderr).not.toContain("node:");
      const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");
      expect(lines, result.stderr).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({ schemaVersion: 1, command: "setup", exitCode: 0, meta: { demo: true } });
      expect(result.exitCode).toBe(0);
      assertNoNetwork(box.networkLog);
    }
    expect(await snapshotTree(box.project)).toEqual(PROJECT_SEED);
  });

  it("mcp --demo: stdout carries only JSON-RPC, every request is answered, no network, no files", { timeout: KILL_AFTER_MS + 10_000 }, async () => {
    const box = await sandbox("mcp");
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "demo-e2e", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "arcopolis_status", arguments: {} } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "arcopolis_read", arguments: { operationId: "getTrending" } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "arcopolis_visitor_status", arguments: {} } },
    ];
    // Written in one go and stdin closed at once: the server must still answer everything before it exits.
    const result = await spawnCli(["mcp", "--demo"], {
      cwd: box.project,
      env: demoEnv(box),
      nodeArgs: ["--import", NO_NETWORK],
      input: requests.map((message) => JSON.stringify(message)).join("\n") + "\n",
      killAfterMs: KILL_AFTER_MS,
    });
    expect(result.killed, result.stderr).toBe(false);
    expect(result.exitCode, result.stderr).toBe(0);
    const messages = result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { jsonrpc: string; id?: number; result?: Record<string, unknown>; error?: unknown });
    for (const message of messages) expect(message.jsonrpc).toBe("2.0");
    expect(messages.map((message) => message.id).sort()).toEqual([1, 2, 3, 4, 5]);
    for (const message of messages) expect(message.error, JSON.stringify(message)).toBeUndefined();
    const calls = messages.filter((message) => (message.id ?? 0) >= 3);
    for (const call of calls) {
      expect(call.result?.isError, JSON.stringify(call.result)).not.toBe(true);
      expect(call.result?.structuredContent).toMatchObject({ schemaVersion: 1, ok: true, meta: { demo: true } });
    }
    for (const line of result.stderr.split("\n").filter((entry) => entry.trim() !== "")) {
      expect(JSON.parse(line)).toMatchObject({ server: "arcopolis", phase: expect.any(String) });
    }
    assertNoNetwork(box.networkLog);
    assertNoKeyMaterial(result);
    expect(await snapshotTree(box.home)).toEqual({});
    expect(await snapshotTree(box.config)).toEqual({});
    expect(await snapshotTree(box.project)).toEqual(PROJECT_SEED);
  });
});
