/**
 * `arcopolis mcp` through `runCli` with piped streams: stdout carries only
 * JSON-RPC, diagnostics are JSON lines on stderr, the process ends cleanly
 * when stdin ends, and the SDK is only ever loaded by dynamic import.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/main.js";
import type { FetchLike } from "../src/core/http.js";
import { READ_TOOL_NAMES, SETUP_TOOL_NAMES, WRITE_TOOL_NAMES } from "../src/mcp/tools.js";

/** Default registration: the read tools with the setup tools after `arcopolis_read` (plan §6 order). */
const DEFAULT_TOOLS = [...READ_TOOL_NAMES.slice(0, 4), ...SETUP_TOOL_NAMES, ...READ_TOOL_NAMES.slice(4)];
import { Capture, fakeFetch, fakeKey, json, run, tempDir } from "./helpers.js";

type Json = Record<string, unknown>;

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

let dir: string;
let cfg: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir("arcopolis-mcp-cmd-"));
  cfg = path.join(dir, "cfg");
});

afterEach(async () => {
  await cleanup();
});

/** A running `arcopolis mcp` with line-level access to its stdout. */
interface Running {
  send(message: Json): void;
  /** Resolves with the response whose id matches. */
  response(id: number): Promise<Json>;
  /** Ends stdin and resolves with the exit code, stdout lines, and stderr text. */
  finish(): Promise<{ exitCode: number; lines: string[]; stderr: string }>;
}

function start(argv: string[], env: Record<string, string> = {}, fetchImpl?: FetchLike): Running {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new Capture();
  const lines: string[] = [];
  const waiting = new Map<number, (message: Json) => void>();
  const seen = new Map<number, Json>();
  let buffer = "";
  stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      lines.push(line);
      try {
        const message = JSON.parse(line) as Json;
        if (typeof message.id === "number") {
          seen.set(message.id, message);
          waiting.get(message.id)?.(message);
        }
      } catch {
        // Recorded in `lines`; the test asserts every line parses.
      }
      index = buffer.indexOf("\n");
    }
  });
  const exit = runCli({
    argv,
    env: { ARCOPOLIS_CONFIG_DIR: cfg, ...env },
    cwd: dir,
    stdin,
    stdout,
    stderr,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    fetchImpl: fetchImpl ?? fakeFetch(() => json(500, { error: { code: "SHOULD_NOT_CALL" } })).fetchImpl,
  });
  return {
    send(message: Json): void {
      stdin.write(`${JSON.stringify(message)}\n`);
    },
    response(id: number): Promise<Json> {
      const done = seen.get(id);
      if (done) return Promise.resolve(done);
      return new Promise<Json>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no response ${id}; stderr: ${stderr.text}`)), 10_000);
        waiting.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    async finish(): Promise<{ exitCode: number; lines: string[]; stderr: string }> {
      stdin.end();
      const exitCode = await exit;
      return { exitCode, lines: lines.filter((line) => line.trim() !== ""), stderr: stderr.text };
    },
  };
}

async function initialize(server: Running): Promise<void> {
  server.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  const init = await server.response(1);
  expect(init).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "arcopolis" } } });
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

async function listTools(server: Running, id: number): Promise<string[]> {
  server.send({ jsonrpc: "2.0", id, method: "tools/list" });
  const response = await server.response(id);
  return ((response.result as { tools: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name);
}

function assertJsonRpcOnly(lines: string[]): void {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    const message = JSON.parse(line) as Json;
    expect(message.jsonrpc).toBe("2.0");
  }
}

function stderrEvents(stderr: string): Json[] {
  return stderr
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Json);
}

describe("arcopolis mcp (stdio)", () => {
  it("serves JSON-RPC on stdout only and exits 0 when stdin ends", async () => {
    const key = fakeKey("c");
    const server = start(["mcp"], { ARCOPOLIS_API_KEY: key });
    await initialize(server);
    expect(await listTools(server, 2)).toEqual(DEFAULT_TOOLS);
    server.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "arcopolis_status", arguments: {} } });
    const status = await server.response(3);
    expect(status).toMatchObject({ result: { structuredContent: { ok: true, command: "arcopolis_status", data: { read: { configured: true, source: "env" } } } } });
    const { exitCode, lines, stderr } = await server.finish();
    expect(exitCode).toBe(0);
    assertJsonRpcOnly(lines);
    expect(lines.join("\n")).not.toContain(key);
    const events = stderrEvents(stderr);
    expect(events.every((event) => event.server === "arcopolis" && typeof event.phase === "string" && typeof event.ts === "string")).toBe(true);
    expect(events.map((event) => event.phase)).toEqual(
      expect.arrayContaining(["process_start", "tools_registered", "stdio_connect_begin", "server_ready", "shutdown_begin", "server_closed"]),
    );
    expect(stderr).not.toContain(key);
  });

  it("--allow-writes registers the write tools; --no-setup drops the setup tools; writePolicy tty-only registers no writes", async () => {
    const writes = start(["mcp", "--allow-writes", "--no-setup"]);
    await initialize(writes);
    expect(await listTools(writes, 2)).toEqual([...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]);
    const done = await writes.finish();
    expect(done.exitCode).toBe(0);
    assertJsonRpcOnly(done.lines);

    await mkdir(cfg, { recursive: true, mode: 0o700 });
    await writeFile(path.join(cfg, "config.json"), JSON.stringify({ schemaVersion: 1, writePolicy: "tty-only", output: "auto" }), { mode: 0o600 });
    const ttyOnly = start(["mcp", "--allow-writes"]);
    await initialize(ttyOnly);
    expect(await listTools(ttyOnly, 2)).toEqual(DEFAULT_TOOLS);
    const finished = await ttyOnly.finish();
    expect(finished.exitCode).toBe(0);
    expect(stderrEvents(finished.stderr)).toContainEqual(expect.objectContaining({ phase: "tools_registered", details: expect.objectContaining({ writePolicy: "tty-only" }) }));
  });

  it("--demo serves fixtures through the tools", async () => {
    const server = start(["mcp", "--demo"]);
    await initialize(server);
    server.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "arcopolis_read", arguments: { operationId: "listAgents" } } });
    expect(await server.response(2)).toMatchObject({ result: { structuredContent: { ok: true, meta: { demo: true } } } });
    const { exitCode, lines } = await server.finish();
    expect(exitCode).toBe(0);
    assertJsonRpcOnly(lines);
  });

  it("tool calls use the runner's fetch (the process-level hook reaches every tool context)", async () => {
    const key = fakeKey("c");
    const fake = fakeFetch(() => json(200, { data: { hotThreads: [], trendingTopics: [], risingAgents: [] } }));
    const server = start(["mcp"], { ARCOPOLIS_API_KEY: key }, fake.fetchImpl);
    await initialize(server);
    server.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "arcopolis_read", arguments: { operationId: "getTrending" } } });
    expect(await server.response(2)).toMatchObject({ result: { structuredContent: { ok: true, effects: { requests: 1 } } } });
    const { exitCode } = await server.finish();
    expect(exitCode).toBe(0);
    expect(fake.calls.map((call) => call.url)).toEqual(["https://api.arcopolis.ai/v1/trending"]);
    expect(fake.calls[0]?.headers["user-agent"]).toMatch(/ mcp$/);
  });

  it("answers every request written just before stdin closes", async () => {
    const server = start(["mcp", "--demo"]);
    server.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    server.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "arcopolis_status", arguments: {} } });
    server.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const { exitCode, lines } = await server.finish();
    expect(exitCode).toBe(0);
    assertJsonRpcOnly(lines);
    const ids = lines.map((line) => (JSON.parse(line) as Json).id).sort();
    expect(ids).toEqual([1, 2, 3]);
  });

  it("mcp --help --json prints its schema entry", async () => {
    const result = await run(["mcp", "--help", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ ok: true, meta: { help: true }, data: { name: "mcp" } });
  });
});

describe("SDK loading", () => {
  async function sourceFiles(root: string): Promise<string[]> {
    const entries = await readdir(root, { withFileTypes: true, recursive: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ts")).map((entry) => path.join(entry.parentPath, entry.name));
  }

  it("only src/mcp imports the SDK, zod, or src/mcp statically; the mcp command imports them dynamically", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const relative = path.relative(SRC, file);
      if (relative.startsWith(`mcp${path.sep}`)) continue;
      const text = await readFile(file, "utf8");
      const staticImports = [...text.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1] ?? "");
      for (const specifier of staticImports) {
        if (specifier.startsWith("@modelcontextprotocol/") || specifier === "zod" || /(^|\/)mcp\/(server|tools|response|guards|startupLog)\.js$/.test(specifier)) {
          offenders.push(`${relative}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    const command = await readFile(path.join(SRC, "cli/commands/mcp.ts"), "utf8");
    expect(command).toContain('import("../../mcp/server.js")');
    expect(command).toContain('import("@modelcontextprotocol/sdk/server/stdio.js")');
  });

  it("src/mcp never writes to process stdout or uses console", async () => {
    for (const file of await sourceFiles(path.join(SRC, "mcp"))) {
      const text = await readFile(file, "utf8");
      expect(text).not.toMatch(/console\.|process\.stdout/);
    }
  });
});
