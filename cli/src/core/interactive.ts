/**
 * Interactivity detection, prompts, and live-write authorization (plan §3.3).
 * Without a TTY the CLI never prompts: a would-be prompt exits 10.
 */
import { CliError } from "./errors.js";

/**
 * Environment markers that identify a coding agent driving the CLI. Any
 * match makes the session non-interactive. Extend this list; it is tested.
 */
export const AGENT_MARKERS: ReadonlyArray<{ name: string; values?: readonly string[] }> = [
  { name: "CLAUDECODE", values: ["1"] },
];

/** Interactive prompts give up after this long and exit 10. */
export const PROMPT_TIMEOUT_MS = 120_000;

export interface InteractivityInput {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  noInputFlag: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

export interface Interactivity {
  interactive: boolean;
  /** Why the session is non-interactive (`stdin_not_tty`, `no_input_flag`, `env:CI`, `agent:CLAUDECODE`, ...). */
  reasons: string[];
}

function truthyFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/**
 * Non-interactive when stdin or stdout is not a TTY, `--no-input`,
 * `ARCOPOLIS_NO_INPUT=1`, `CI` is set (any value except empty, `0`, or
 * `false`), or an agent marker is present.
 */
export function detectInteractivity(input: InteractivityInput): Interactivity {
  const reasons: string[] = [];
  if (!input.stdinIsTTY) reasons.push("stdin_not_tty");
  if (!input.stdoutIsTTY) reasons.push("stdout_not_tty");
  if (input.noInputFlag) reasons.push("no_input_flag");
  if (truthyFlag(input.env.ARCOPOLIS_NO_INPUT)) reasons.push("env:ARCOPOLIS_NO_INPUT");
  if (truthyFlag(input.env.CI)) reasons.push("env:CI");
  for (const marker of AGENT_MARKERS) {
    const value = input.env[marker.name];
    if (value === undefined) continue;
    if (!marker.values || marker.values.includes(value.trim())) reasons.push(`agent:${marker.name}`);
  }
  return { interactive: reasons.length === 0, reasons };
}

/** Streams a prompt needs. Prompts are written to stderr so stdout stays clean. */
export interface PromptStreams {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  stderr: { write(chunk: string): unknown };
}

export interface PromptOptions {
  interactive: boolean;
  streams: PromptStreams;
  timeoutMs?: number;
}

function promptTimeout(): CliError {
  return new CliError("PROMPT_TIMEOUT", "No answer within 120 seconds.", {
    hint: "Run the command again when the human is at the terminal.",
  });
}

/**
 * Reads one line from stdin. Resolves `null` on end of input. Rejects with
 * `PROMPT_TIMEOUT` after the timeout.
 */
function readLine(streams: PromptStreams, timeoutMs: number, hidden: boolean): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    const stdin = streams.stdin;
    let buffer = "";
    let settled = false;
    const raw = hidden && typeof stdin.setRawMode === "function" && stdin.isTTY === true;
    const finish = (value: string | null, error?: CliError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      if (raw) stdin.setRawMode?.(false);
      stdin.pause();
      if (hidden) streams.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          finish(null, new CliError("CONFIRMATION_DECLINED", "Cancelled at the prompt.", { humanDecision: true }));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish(buffer);
          return;
        }
        if (raw && (char === "\u007f" || char === "\b")) {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += char;
      }
    };
    const onEnd = (): void => finish(buffer.length > 0 ? buffer : null);
    const timer = setTimeout(() => finish(null, promptTimeout()), timeoutMs);
    if (raw) stdin.setRawMode?.(true);
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.resume();
  });
}

/**
 * Asks a y/N question on stderr. Non-interactive sessions get
 * `CONFIRMATION_REQUIRED` (exit 10) instead of a prompt. Returns true only
 * for an explicit `y` or `yes`.
 */
export async function promptConfirm(question: string, options: PromptOptions): Promise<boolean> {
  if (!options.interactive) {
    throw new CliError("CONFIRMATION_REQUIRED", `${question} (a confirmation is needed and this session cannot prompt)`, {
      humanDecision: true,
    });
  }
  options.streams.stderr.write(`${question} [y/N] `);
  const answer = await readLine(options.streams, options.timeoutMs ?? PROMPT_TIMEOUT_MS, false);
  return answer !== null && /^(y|yes)$/i.test(answer.trim());
}

/**
 * Reads a secret without echo (raw TTY mode). Non-interactive sessions get
 * `INPUT_REQUIRED` (exit 10). The value is never written anywhere.
 */
export async function promptHidden(question: string, options: PromptOptions): Promise<string> {
  if (!options.interactive) {
    throw new CliError("INPUT_REQUIRED", "This step needs typed input and this session cannot prompt.", {
      humanDecision: true,
    });
  }
  options.streams.stderr.write(`${question} `);
  const answer = await readLine(options.streams, options.timeoutMs ?? PROMPT_TIMEOUT_MS, true);
  if (answer === null || answer.trim() === "") {
    throw new CliError("INPUT_REQUIRED", "No input was entered.", { humanDecision: true });
  }
  return answer.trim();
}

/** User-level write policy from `config.json` (never from project files). */
export type WritePolicy = "flag" | "tty-only" | "deny";

export interface WriteAuthorizationInput {
  /** `--execute` was given. */
  execute: boolean;
  interactive: boolean;
  writePolicy: WritePolicy;
  /** Error message for the non-interactive preview (plan §4.6 example wording). */
  previewMessage: string;
  /** Top-level `data` of the exit-10 document, e.g. `{preview, previewDigest, menuCheck}`. */
  previewData?: unknown;
  /** The y/N question shown in a TTY. */
  question: string;
  /** Prompt function; defaults are wired by the command context (`ctx.confirm`). */
  confirm: (question: string) => Promise<boolean>;
}

/** How a live write was authorized. */
export type WriteAuthorization = "execute_flag" | "tty_prompt";

/**
 * Applies `--execute` and `writePolicy` (plan §3.3):
 * - `deny`: `WRITES_DISABLED` (exit 4).
 * - `tty-only`: needs an interactive `y`, even with `--execute`.
 * - `flag` (default): `--execute` is enough; without it a TTY gets a y/N
 *   prompt and a non-TTY gets `CONFIRMATION_REQUIRED` (exit 10) naming the
 *   flag, with the preview as `data`.
 * A declined prompt throws `CONFIRMATION_DECLINED` (exit 10).
 */
export async function authorizeLiveWrite(input: WriteAuthorizationInput): Promise<WriteAuthorization> {
  if (input.writePolicy === "deny") {
    throw new CliError("WRITES_DISABLED", "Live writes are disabled by writePolicy \"deny\" in config.json.", {
      hint: "Only the human can change writePolicy in the user config.json.",
      humanDecision: true,
    });
  }
  const needsPrompt = input.writePolicy === "tty-only" || !input.execute;
  if (!needsPrompt) return "execute_flag";
  if (!input.interactive) {
    const hint =
      input.writePolicy === "tty-only"
        ? "writePolicy is \"tty-only\": a human must confirm this write at an interactive terminal."
        : "Add --execute only when the human asked for this specific live action in this session.";
    throw new CliError("CONFIRMATION_REQUIRED", input.previewMessage, {
      hint,
      humanDecision: true,
      data: input.previewData,
    });
  }
  const yes = await input.confirm(input.question);
  if (!yes) {
    throw new CliError("CONFIRMATION_DECLINED", "The write was not confirmed. Nothing was sent.", {
      humanDecision: true,
      data: input.previewData,
    });
  }
  return "tty_prompt";
}
