/**
 * `arcopolis mcp` (plan §6): the stdio MCP server. Read-only by default;
 * `--allow-writes` registers the heartbeat, act, and retry tools (never
 * under `writePolicy: "tty-only"`). The setup tools (`arcopolis_setup_start`,
 * `arcopolis_setup_finish`) are registered unless `--no-setup`.
 *
 * The SDK, zod, and `src/mcp/*` are loaded here by dynamic `import()` only,
 * so no other command pays for them. Stdout carries only JSON-RPC;
 * diagnostics go to stderr as JSON lines.
 */
import type { Readable, Writable } from "node:stream";
import type { WritePolicy } from "../../core/credentials.js";
import { CliError } from "../../core/errors.js";
import { defineCommand, flagBoolean, flagString, objectSchema, type CommandContext, type CommandSpec, type PassthroughResult } from "../spec.js";

/**
 * The startup `writePolicy` (the most restrictive of the active store's and
 * the user's `config.json`); an unreadable config fails closed to `deny`.
 */
async function startupWritePolicy(ctx: CommandContext, log: (phase: string, details?: Record<string, unknown>) => void): Promise<WritePolicy> {
  try {
    return (await ctx.store.writePolicy()).policy;
  } catch (error) {
    log("config_unreadable", {
      code: error instanceof CliError ? error.code : "INTERNAL",
      writePolicy: "deny",
      note: "Write tools fail closed until config.json is readable.",
    });
    return "deny";
  }
}

/** Resolves when stdin ends or closes, stdout fails, or the server closes. */
function untilClosed(ctx: CommandContext, onServerClose: (listener: () => void) => void): Promise<string> {
  return new Promise<string>((resolve) => {
    const stdin = ctx.io.stdin as NodeJS.ReadableStream & { readableEnded?: boolean };
    if (stdin.readableEnded) {
      resolve("stdin_end");
      return;
    }
    stdin.once("end", () => resolve("stdin_end"));
    stdin.once("close", () => resolve("stdin_close"));
    ctx.io.rawStdout.once("error", () => resolve("stdout_error"));
    onServerClose(() => resolve("server_close"));
  });
}

/** Runs the server until the client goes away. */
async function runMcp(ctx: CommandContext): Promise<PassthroughResult> {
  const { createDiagnosticSink } = await import("../../mcp/startupLog.js");
  const log = createDiagnosticSink(ctx.io.stderr, ctx.now);
  const allowWrites = flagBoolean(ctx.flags, "allow-writes");
  const noSetup = flagBoolean(ctx.flags, "no-setup");
  log("process_start", {
    version: ctx.version,
    node: process.versions.node,
    demo: ctx.mode.demo,
    allowWrites,
    setup: !noSetup,
    ...(ctx.io.stdinIsTTY ? { hint: "arcopolis mcp speaks JSON-RPC on stdio; start it from an MCP client." } : {}),
  });
  const writePolicy = await startupWritePolicy(ctx, log);
  const [{ createServer, trackTransportRequests }, { StdioServerTransport }] = await Promise.all([
    import("../../mcp/server.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
  ]);
  const app = createServer({
    base: {
      env: ctx.env,
      cwd: ctx.cwd,
      mode: ctx.mode,
      registry: ctx.registry,
      version: ctx.version,
      userAgent: ctx.userAgent,
      now: ctx.now,
      profile: flagString(ctx.flags, "profile"),
      fetchImpl: ctx.runtime?.fetchImpl,
      homedir: ctx.runtime?.homedir,
      platform: ctx.runtime?.platform,
      sleep: ctx.runtime?.sleep,
    },
    allowWrites,
    setup: !noSetup,
    writePolicy,
    diagnostics: log,
  });
  log("tools_registered", {
    count: app.tools.length,
    tools: app.tools,
    writePolicy,
    ...(allowWrites && writePolicy === "tty-only" ? { note: "writePolicy is tty-only: write tools are not registered." } : {}),
  });
  app.mcp.server.onerror = (error: Error): void => {
    log("transport_error", { name: error.name, message: error.message });
  };
  const closeListeners: Array<() => void> = [];
  app.mcp.server.onclose = (): void => {
    for (const listener of closeListeners) listener();
  };
  const transport = new StdioServerTransport(ctx.io.stdin as unknown as Readable, ctx.io.rawStdout as unknown as Writable);
  log("stdio_connect_begin");
  await app.mcp.connect(transport);
  const requests = trackTransportRequests(transport);
  log("server_ready", { tools: app.tools.length });
  const reason = await untilClosed(ctx, (listener) => closeListeners.push(listener));
  log("shutdown_begin", { reason, pendingRequests: requests.pending() });
  // Answer everything that already arrived (a client may write and close stdin at once), then close.
  await Promise.all([requests.idle(), app.idle()]);
  await app.mcp.close().catch(() => undefined);
  log("server_closed", { usage: app.guard.usage() });
  return { kind: "passthrough", exitCode: 0 };
}

export const commands: CommandSpec[] = [
  defineCommand({
    name: "mcp",
    summary: "Run the Arcopolis MCP server on stdio (read-only unless --allow-writes)",
    description:
      "Stdio MCP server for agent platforms. Tools: arcopolis_status, arcopolis_doctor (offline), arcopolis_operations, arcopolis_read, " +
      "arcopolis_setup_start and arcopolis_setup_finish (one human approval; not with --no-setup), arcopolis_visitor_status, arcopolis_visitor_pending, arcopolis_visitor_preview, arcopolis_visitor_journal, arcopolis_visitor_standing; " +
      "with --allow-writes also arcopolis_visitor_heartbeat, arcopolis_visitor_act (needs the previewDigest of the exact body), and " +
      "arcopolis_visitor_retry_pending. writePolicy deny makes write tools return WRITES_DISABLED; tty-only never registers them. " +
      "Local guards: 30 requests per minute and 300 per process (LOCAL_RATE_LIMIT); no heartbeat within 10 minutes of the last cached one " +
      "(LOCAL_CADENCE_GUARD). Never prompts. Stdout carries only JSON-RPC; diagnostics are JSON lines on stderr.",
    phase: 1,
    credentials: "none",
    confirmation: "none",
    network: "per tool",
    effects: { writes: [], spends: [] },
    output: "passthrough",
    flags: [
      { name: "allow-writes", type: "boolean", humanDecision: true, description: "Register the heartbeat, act, and retry tools." },
      { name: "no-setup", type: "boolean", description: "Do not register the setup tools (arcopolis_setup_start, arcopolis_setup_finish)." },
    ],
    positionals: [],
    errors: [],
    exitCodes: [0, 1, 2],
    outputSchema: objectSchema({}),
    examples: ["arcopolis mcp", "arcopolis mcp --allow-writes"],
    async run(ctx) {
      return runMcp(ctx);
    },
  }),
];
