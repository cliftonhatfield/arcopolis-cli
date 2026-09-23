/**
 * `arcopolis exec [--visitor] [--raw-output] -- CMD ARGS…` (plan §4.7).
 *
 * Runs a child process with `ARCOPOLIS_API_BASE`, `ARCOPOLIS_API_KEY`,
 * `ARCOPOLIS_VISITOR_API_KEY`, and `ARCOPOLIS_VISITOR_AGENT_ID` injected, so
 * code can use the keys without anyone printing them. No shell is involved.
 * stdio and signals are forwarded and the CLI exits with the child's code.
 * Unless `--raw-output`, the child's stdout and stderr go through the line
 * redactor whenever the session is not a plain interactive terminal: stdout
 * or stdin is not a TTY, `--no-input`, `CI`, or an agent marker such as
 * `CLAUDECODE=1` (agent harnesses often run commands in a PTY). Missing credentials exit
 * 3 before anything is spawned. On success nothing is printed besides the
 * child's own output (a passthrough result, no document).
 */
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import type { EventEmitter } from "node:events";
import { constants as osConstants } from "node:os";
import type { Env } from "../../core/credentials.js";
import { CliError } from "../../core/errors.js";
import { createLineRedactor, type TextSink } from "../../core/redact.js";
import { defineCommand, flagBoolean, objectSchema, type CommandContext, type CommandSpec } from "../spec.js";
import { credentialEnvVars } from "./env.js";

/** Signals forwarded to the child while it runs. */
export const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

/** Signals a terminal already delivers to the whole foreground process group. */
const TERMINAL_SIGNALS: ReadonlySet<NodeJS.Signals> = new Set(["SIGINT", "SIGQUIT"]);

/** Options for {@link runChild}. */
export interface RunChildOptions {
  command: string;
  args: readonly string[];
  env: Env;
  cwd: string;
  /** Pipe stdout/stderr through the line redactor. */
  redactOutput: boolean;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Inherit the real process fds when the streams are the process's own (TTY passthrough). */
  inheritStdio: { stdin: boolean; stdout: boolean; stderr: boolean };
  /** Where signals come from (the process by default; tests pass an EventEmitter). */
  signalSource?: EventEmitter;
  /** Forward SIGINT/SIGQUIT too (false when the terminal already delivers them to the child). */
  forwardTerminalSignals: boolean;
  onSpawn?: (child: ChildProcess) => void;
}

/** Exit code for a child that ended by signal (128 + signal number, the shell convention). */
export function signalExitCode(signal: NodeJS.Signals): number {
  const number = (osConstants.signals as Record<string, number | undefined>)[signal];
  return 128 + (number ?? 1);
}

function sinkOf(stream: NodeJS.WritableStream): TextSink {
  return { write: (chunk: string) => stream.write(chunk) };
}

/**
 * Spawns the child without a shell, wires stdio (redacted or raw), forwards
 * signals, and resolves with the child's exit code. A spawn failure (command
 * not found, not executable) rejects with a `CliError` before any output.
 */
export function runChild(options: RunChildOptions): Promise<number> {
  const stdio: StdioOptions = [
    options.inheritStdio.stdin ? "inherit" : "pipe",
    !options.redactOutput && options.inheritStdio.stdout ? "inherit" : "pipe",
    !options.redactOutput && options.inheritStdio.stderr ? "inherit" : "pipe",
  ];
  return new Promise<number>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv,
        stdio,
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      reject(spawnError(options.command, error));
      return;
    }
    const signals = options.signalSource ?? process;
    const handlers = new Map<NodeJS.Signals, () => void>();
    let started = false;
    const cleanup = (): void => {
      for (const [signal, handler] of handlers) signals.removeListener(signal, handler);
      handlers.clear();
      if (child.stdin && !options.inheritStdio.stdin) {
        options.stdin.unpipe(child.stdin);
        options.stdin.pause();
      }
    };
    child.on("error", (error) => {
      if (!started) {
        cleanup();
        reject(spawnError(options.command, error));
      }
    });
    child.once("spawn", () => {
      started = true;
      options.onSpawn?.(child);
      for (const signal of FORWARDED_SIGNALS) {
        if (process.platform === "win32" && signal !== "SIGINT" && signal !== "SIGTERM") continue;
        const handler = (): void => {
          if (!TERMINAL_SIGNALS.has(signal) || options.forwardTerminalSignals) {
            try {
              child.kill(signal);
            } catch {
              // The child already exited.
            }
          }
        };
        handlers.set(signal, handler);
        signals.on(signal, handler);
      }
    });
    if (child.stdin && !options.inheritStdio.stdin) {
      child.stdin.on("error", () => undefined);
      options.stdin.pipe(child.stdin);
    }
    const wire = (from: NodeJS.ReadableStream | null, to: NodeJS.WritableStream): (() => void) => {
      if (!from) return () => undefined;
      if (options.redactOutput) {
        const redactor = createLineRedactor(sinkOf(to));
        from.on("data", (chunk: Buffer) => redactor.push(chunk));
        return () => redactor.flush();
      }
      from.on("data", (chunk: Buffer) => to.write(chunk));
      return () => undefined;
    };
    const flushOut = wire(child.stdout, options.stdout);
    const flushErr = wire(child.stderr, options.stderr);
    child.once("close", (code, signal) => {
      flushOut();
      flushErr();
      cleanup();
      if (!started) return;
      resolve(code ?? (signal ? signalExitCode(signal) : 1));
    });
  });
}

function spawnError(command: string, error: unknown): CliError {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "ENOENT") {
    return new CliError("COMMAND_NOT_FOUND", `Command not found: ${command}. exec runs it without a shell.`, {
      category: "invalid_input",
      hint: "Use the program name or path exactly (shell built-ins, aliases, and pipes are not available).",
      humanDecision: false,
    });
  }
  if (code === "EACCES" || code === "EPERM") {
    return new CliError("COMMAND_NOT_EXECUTABLE", `${command} is not executable.`, { category: "invalid_input", humanDecision: false });
  }
  return new CliError("SPAWN_FAILED", `Could not start ${command}.`, { category: "internal", humanDecision: false });
}

/** Builds the child environment: the caller's environment plus the resolved credentials. */
export async function execEnvironment(ctx: CommandContext, visitorMode: boolean): Promise<{ env: Record<string, string>; injected: string[] }> {
  const resolved = await ctx.store.resolved();
  if (visitorMode) {
    if (!resolved.visitor) {
      throw new CliError("NO_CREDENTIALS", "exec --visitor needs a visitor key, and none is configured.", {
        hint: "Set ARCOPOLIS_VISITOR_API_KEY or run arcopolis setup --visitor --json (only if the human asked for a visitor).",
        next: [{ command: "arcopolis status --json", why: "See which credentials resolve (no network)", humanDecision: false }],
      });
    }
    if (!resolved.agentId) {
      throw new CliError("NO_CREDENTIALS", "exec --visitor needs a visitor agent id, and none is configured.", {
        hint: "Set ARCOPOLIS_VISITOR_AGENT_ID, or add visitor.agentId to arcopolis.json.",
      });
    }
  } else if (!resolved.read && !resolved.visitor) {
    throw new CliError("NO_CREDENTIALS", "No key is configured, so there is nothing to inject.", {
      hint: "Run arcopolis setup --json, or ask the human to set the key in the agent platform's secret settings.",
      next: [{ command: "arcopolis setup --json", why: "Get credentials with one human approval", humanDecision: false }],
    });
  }
  const vars = credentialEnvVars(ctx, resolved);
  if (visitorMode && vars.ARCOPOLIS_VISITOR_API_KEY) vars.ARCOPOLIS_API_KEY = vars.ARCOPOLIS_VISITOR_API_KEY;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(ctx.env)) if (value !== undefined) env[name] = value;
  Object.assign(env, vars);
  return { env, injected: Object.keys(vars) };
}

export const commands: CommandSpec[] = [
  defineCommand({
    name: "exec",
    summary: "Run a command with ARCOPOLIS_* credentials injected (no shell; exits with the child's code)",
    description:
      "Injects ARCOPOLIS_API_BASE, ARCOPOLIS_API_KEY (read key), ARCOPOLIS_VISITOR_API_KEY (drive key), and " +
      "ARCOPOLIS_VISITOR_AGENT_ID. --visitor also sets ARCOPOLIS_API_KEY to the drive key for older starter copies. " +
      "Put the command after --. The child's output is redacted unless --raw-output, except in a plain interactive terminal " +
      "(stdout and stdin are TTYs and no --no-input, CI, or agent marker such as CLAUDECODE=1).",
    phase: 1,
    credentials: "stored",
    confirmation: "none",
    network: "none itself",
    effects: { writes: [], spends: [] },
    output: "passthrough",
    flags: [
      { name: "visitor", type: "boolean", description: "Also set ARCOPOLIS_API_KEY to the drive key (older starter copies)." },
      { name: "raw-output", type: "boolean", description: "Do not redact the child's output." },
    ],
    positionals: [{ name: "command", description: "Command and arguments after --.", required: true, variadic: true }],
    errors: ["NO_CREDENTIALS", "STORED_KEY_ORIGIN_MISMATCH", "COMMAND_NOT_FOUND", "COMMAND_NOT_EXECUTABLE", "USAGE_ERROR", "MISSING_ARGUMENT"],
    exitCodes: [0, 1, 2, 3],
    outputSchema: objectSchema({
      command: { type: "array", items: { type: "string" }, description: "Demo mode only: the command that would run." },
      injected: { type: "array", items: { type: "string" }, description: "Demo mode only: variable names that would be injected." },
    }),
    examples: ["arcopolis exec -- node app.mjs", "arcopolis exec --visitor -- node visitor.mjs heartbeat"],
    async run(ctx) {
      const [command, ...args] = ctx.positionals;
      if (!command) throw new CliError("MISSING_ARGUMENT", "Missing <command>: put the command after --.", { humanDecision: false });
      const visitorMode = flagBoolean(ctx.flags, "visitor");
      const { env, injected } = await execEnvironment(ctx, visitorMode);
      if (ctx.mode.demo) {
        return { data: { command: [command, ...args], injected, spawned: false } };
      }
      ctx.io.trace(`exec: ${command} with ${injected.join(", ")} injected`);
      // Agent markers make a PTY session non-interactive, and agents capture PTY output into transcripts.
      const redactOutput = (!ctx.mode.interactive || !ctx.io.stdoutIsTTY) && !flagBoolean(ctx.flags, "raw-output");
      const exitCode = await runChild({
        command,
        args,
        env,
        cwd: ctx.cwd,
        redactOutput,
        stdin: ctx.io.stdin,
        stdout: ctx.io.rawStdout,
        stderr: ctx.io.rawStderr,
        inheritStdio: {
          stdin: ctx.io.stdin === process.stdin,
          stdout: ctx.io.rawStdout === process.stdout,
          stderr: ctx.io.rawStderr === process.stderr,
        },
        forwardTerminalSignals: !ctx.io.stdinIsTTY,
      });
      return { kind: "passthrough", exitCode };
    },
  }),
];
