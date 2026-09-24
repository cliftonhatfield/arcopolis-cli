/**
 * The runner: argv guard → command lookup → flag parsing → run → exactly
 * one document on stdout (JSON mode) or human text. Every failure path ends
 * here; `bin.ts` only turns the returned exit code into the process exit.
 */
import { assertNoSecretArguments } from "../core/argvGuard.js";
import type { Env } from "../core/credentials.js";
import { CliError } from "../core/errors.js";
import { buildUserAgent, type FetchLike } from "../core/http.js";
import { detectInteractivity } from "../core/interactive.js";
import {
  Effects,
  Warnings,
  buildErrorDocument,
  buildSuccessDocument,
  renderHumanDefault,
  renderHumanError,
  type DocumentResult,
  type SuccessDocument,
} from "../core/output.js";
import { createRedactingWriter, redact, serializeRedacted, type TextSink } from "../core/redact.js";
import { currentModuleFile, detectInstall, npmSpec, type InstallKind } from "../init/init.js";
import { CLI_VERSION } from "../version.js";
import { createContext, mcpDiagnostic } from "./context.js";
import { parseCommandArgs, preScan, renderCommandHelp, renderOverviewHelp, stripCommandWords } from "./parse.js";
import { COMMANDS, createRegistry, matchCommand } from "./registry.js";
import {
  flagBoolean,
  flagNumber,
  flagString,
  type CommandIO,
  type CommandMode,
  type CommandSpec,
  type RegistryView,
} from "./spec.js";

/** Process-level inputs, injectable for tests. */
export interface CliRuntime {
  /** Arguments after `node bin.js`. */
  argv: readonly string[];
  env: Env;
  cwd: string;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  fetchImpl?: FetchLike;
  now?: () => Date;
  homedir?: string;
  platform?: NodeJS.Platform;
  /** Waits between setup polls (tests pass a fake that advances `now`). */
  sleep?: (ms: number) => Promise<void>;
  /** Opens the approval link in a browser (tests pass a fake). */
  openUrl?: (url: string) => Promise<boolean>;
  version?: string;
  /** Command list override (tests). */
  commands?: readonly CommandSpec[];
  /** How this CLI was launched; tests inject it. Defaults to {@link detectInstall}. */
  installKind?: InstallKind;
}

/**
 * The prefix a human or agent must type to run this CLI again, for `next[]`.
 * An `npx` run is not on PATH, so a bare `arcopolis ...` step would fail with
 * "command not found"; repeat the version-pinned npm form instead.
 */
export function commandPrefix(kind: InstallKind, version: string): string {
  // Always pinned to this version, so a repeated step runs the same CLI (a local install is not on PATH either).
  if (kind === "npx" || kind === "local") return `npx -y ${npmSpec(version)}`;
  return "arcopolis";
}

/** Copies `next[]` with each `arcopolis ...` step in the launch form (never mutates shared step objects). */
export function rewriteNextSteps<T extends { command: string }>(steps: readonly T[], prefix: string): T[] {
  if (prefix === "arcopolis") return [...steps];
  return steps.map((step) =>
    step.command === "arcopolis" || step.command.startsWith("arcopolis ")
      ? { ...step, command: `${prefix}${step.command.slice("arcopolis".length)}` }
      : step,
  );
}

/** Output mode: flags → `ARCOPOLIS_OUTPUT` → JSON when stdout is not a TTY. */
export function resolveJsonMode(options: { json: boolean; output: "human" | "json" | null; env: Env; stdoutIsTTY: boolean }): boolean {
  if (options.output === "human") return false;
  if (options.json || options.output === "json") return true;
  const fromEnv = options.env.ARCOPOLIS_OUTPUT?.trim().toLowerCase();
  if (fromEnv === "json") return true;
  if (fromEnv === "human") return false;
  return !options.stdoutIsTTY;
}

function sinkOf(stream: NodeJS.WritableStream): TextSink {
  return { write: (chunk: string) => stream.write(chunk) };
}

/** Runs one CLI invocation and returns its exit code. Never throws. */
export async function runCli(runtime: CliRuntime): Promise<number> {
  const version = runtime.version ?? CLI_VERSION;
  const now = runtime.now ?? ((): Date => new Date());
  const registry = createRegistry(runtime.commands ?? COMMANDS, version);
  const pre = preScan(runtime.argv);
  const json = resolveJsonMode({ json: pre.json, output: pre.output, env: runtime.env, stdoutIsTTY: runtime.stdoutIsTTY });
  const stdout = createRedactingWriter(sinkOf(runtime.stdout));
  const stderr = createRedactingWriter(sinkOf(runtime.stderr));
  // The JSON document is redacted structurally before it is serialized: the
  // plain-text header rule would corrupt escaped quotes in other agents' text.
  const writeDocument = (doc: object): void => {
    runtime.stdout.write(`${serializeRedacted(doc)}\n`);
  };
  const effects = new Effects(!pre.demo);
  let mcpMode = false;
  const warnings = new Warnings((entry) => {
    if (pre.quiet) return;
    if (mcpMode) stderr.write(mcpDiagnostic("warning", { code: entry.code, message: entry.message }, now()));
    else stderr.write(`warning: ${entry.message}\n`);
  });
  let commandName = "";
  const prefix = commandPrefix(
    runtime.installKind ??
      (await detectInstall({
        moduleFile: currentModuleFile(),
        pathEnv: runtime.env.PATH ?? runtime.env.Path,
        platform: runtime.platform ?? process.platform,
      }).catch((): InstallKind => "source")),
    version,
  );

  const emitError = (error: CliError): number => {
    const doc = buildErrorDocument(commandName, error, effects.snapshot(), warnings.list());
    doc.next = rewriteNextSteps(doc.next, prefix);
    if (json) writeDocument(doc);
    else stderr.write(renderHumanError(doc));
    return doc.exitCode;
  };
  const emitSuccess = (result: DocumentResult, render?: (doc: SuccessDocument) => string): number => {
    const doc = buildSuccessDocument(commandName, result, effects.snapshot(), warnings.list(), pre.demo ? { demo: true } : {});
    doc.next = rewriteNextSteps(doc.next, prefix);
    if (json) writeDocument(doc);
    else stdout.write(render ? render(doc) : renderHumanDefault(doc));
    return 0;
  };

  try {
    // Pure lookup first so the error document can name the command; nothing is parsed before the guard.
    const match = matchCommand(registry, pre.words.map((word) => word.value));
    commandName = match?.spec.name ?? "";
    assertNoSecretArguments(runtime.argv);

    if (!match) {
      if (pre.version) {
        commandName = "version";
        return emitSuccess(
          { data: { version, node: process.versions.node, platform: `${process.platform}-${process.arch}` } },
          () => `arcopolis ${version}\n`,
        );
      }
      if (pre.words.length === 0) {
        commandName = "help";
        return emitSuccess(
          {
            data: {
              cli: "arcopolis",
              version,
              commands: [...registry.commands]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((spec) => ({ name: spec.name, summary: spec.summary })),
            },
            next: [{ command: "arcopolis status --json", why: "Start here (no network)", humanDecision: false }],
          },
          () => renderOverviewHelp(registry.commands, version),
        );
      }
      throw unknownCommand(pre.words.map((word) => word.value).join(" "), registry);
    }

    const spec = match.spec;
    commandName = spec.name;
    mcpMode = spec.name === "mcp";
    const tokens = stripCommandWords(runtime.argv, pre.words, match.length);
    const parsed = parseCommandArgs(spec, tokens);

    if (flagBoolean(parsed.flags, "version")) {
      return emitSuccess(
        { data: { version, node: process.versions.node, platform: `${process.platform}-${process.arch}` } },
        () => `arcopolis ${version}\n`,
      );
    }
    if (flagBoolean(parsed.flags, "help")) {
      return emitSuccess({ data: registry.describe(spec), meta: { help: true } }, () => renderCommandHelp(spec));
    }

    const interactivity = detectInteractivity({
      stdinIsTTY: runtime.stdinIsTTY,
      stdoutIsTTY: runtime.stdoutIsTTY,
      noInputFlag: flagBoolean(parsed.flags, "no-input"),
      env: runtime.env,
    });
    const timeoutSeconds = flagNumber(parsed.flags, "timeout");
    const mode: CommandMode = {
      json,
      interactive: interactivity.interactive,
      nonInteractiveReasons: interactivity.reasons,
      demo: flagBoolean(parsed.flags, "demo"),
      verbose: flagBoolean(parsed.flags, "verbose"),
      quiet: flagBoolean(parsed.flags, "quiet"),
      timeoutMs: timeoutSeconds === undefined ? null : Math.round(timeoutSeconds * 1000),
      mcp: mcpMode,
    };
    const io: CommandIO = {
      stdout,
      stderr,
      progress: (message: string): void => {
        if (!mode.quiet) stderr.write(`${message}\n`);
      },
      trace: (message: string): void => {
        if (mode.verbose) stderr.write(`${redact(message)}\n`);
      },
      rawStdout: runtime.stdout,
      rawStderr: runtime.stderr,
      stdin: runtime.stdin,
      stdinIsTTY: runtime.stdinIsTTY,
      stdoutIsTTY: runtime.stdoutIsTTY,
    };
    const ctx = createContext({
      spec,
      flags: parsed.flags,
      positionals: parsed.positionals,
      env: runtime.env,
      cwd: runtime.cwd,
      mode,
      io,
      effects,
      warnings,
      registry,
      version,
      userAgent: buildUserAgent(version, mcpMode),
      fetchImpl: runtime.fetchImpl,
      now,
      homedir: runtime.homedir,
      platform: runtime.platform,
      sleep: runtime.sleep,
      openUrl: runtime.openUrl,
    });
    if (flagString(parsed.flags, "output") === "human" && flagBoolean(parsed.flags, "json")) {
      warnings.add("OUTPUT_CONFLICT", "--output human overrides --json.");
    }

    const result = await spec.run(ctx);
    if (result.kind === "passthrough") return result.exitCode;
    const renderHuman = spec.renderHuman;
    return emitSuccess(
      result,
      renderHuman
        ? (doc): string => renderHuman({ data: doc.data, meta: doc.meta, next: doc.next, warnings: doc.warnings }, ctx)
        : undefined,
    );
  } catch (error) {
    if (error instanceof CliError) return emitError(error);
    if (pre.verbose && error instanceof Error && error.stack) stderr.write(`${error.stack}\n`);
    const name = error instanceof Error ? error.name : typeof error;
    return emitError(
      new CliError("INTERNAL", `Unexpected internal error (${name}). This is a CLI bug.`, {
        hint: "Report it with the command you ran (re-run with --verbose for a redacted stack on stderr). Do not loop.",
        humanDecision: false,
      }),
    );
  }
}

/** `UNKNOWN_COMMAND` (exit 2) with the closest command names as a hint. */
function unknownCommand(words: string, registry: RegistryView): CliError {
  const first = words.split(" ")[0] ?? "";
  const close = registry.commands
    .map((spec) => spec.name)
    .filter((name) => name.startsWith(first) || name.split(" ")[0] === first)
    .slice(0, 8);
  return new CliError("UNKNOWN_COMMAND", `Unknown command "${words}".`, {
    hint: close.length ? `Did you mean: ${close.join(", ")}? Run arcopolis schema --json for every command.` : "Run arcopolis schema --json for every command.",
    humanDecision: false,
  });
}
