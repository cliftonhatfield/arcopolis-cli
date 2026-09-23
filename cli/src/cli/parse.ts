/**
 * Argument parsing: find the command words, then parse flags with
 * `node:util` `parseArgs` against the command's spec plus the global flags.
 * Every usage problem is a `CliError` with exit 2.
 */
import { parseArgs } from "node:util";
import { CliError } from "../core/errors.js";
import { GLOBAL_FLAGS, GLOBAL_VALUE_FLAGS, type CommandSpec, type FlagSpec, type FlagValue } from "./spec.js";

/** What can be learned from argv before a command is known (output mode, demo, help, version). */
export interface PreScan {
  json: boolean;
  output: "human" | "json" | null;
  demo: boolean;
  quiet: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  /** Non-flag tokens before `--`, with their argv index. */
  words: Array<{ value: string; index: number }>;
}

/**
 * Lenient scan of argv up to `--`. Global value flags (`--output`,
 * `--profile`, `--timeout`) consume the next token.
 */
export function preScan(argv: readonly string[]): PreScan {
  const result: PreScan = {
    json: false,
    output: null,
    demo: false,
    quiet: false,
    verbose: false,
    help: false,
    version: false,
    words: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") break;
    if (token === "-h") {
      result.help = true;
      continue;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = token.slice(2, eq === -1 ? undefined : eq);
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      let value = inline;
      if (GLOBAL_VALUE_FLAGS.has(name) && inline === undefined) {
        value = argv[index + 1];
        index += 1;
      }
      switch (name) {
        case "json":
          result.json = true;
          break;
        case "output":
          if (value === "human" || value === "json") result.output = value;
          break;
        case "demo":
          result.demo = true;
          break;
        case "quiet":
          result.quiet = true;
          break;
        case "verbose":
          result.verbose = true;
          break;
        case "help":
          result.help = true;
          break;
        case "version":
          result.version = true;
          break;
        default:
          break;
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1) continue;
    result.words.push({ value: token, index });
  }
  return result;
}

/** argv with the matched command words removed. */
export function stripCommandWords(argv: readonly string[], words: PreScan["words"], count: number): string[] {
  const drop = new Set(words.slice(0, count).map((word) => word.index));
  return argv.filter((_token, index) => !drop.has(index));
}

type ParseOption = { type: "string" | "boolean"; multiple?: boolean; short?: string };

function parseOptions(flags: readonly FlagSpec[]): Record<string, ParseOption> {
  const options: Record<string, ParseOption> = {};
  for (const flag of flags) {
    options[flag.name] = {
      type: flag.type === "boolean" ? "boolean" : "string",
      ...(flag.multiple ? { multiple: true } : {}),
      ...(flag.short ? { short: flag.short } : {}),
    };
  }
  return options;
}

/** Global flags merged with a command's flags (the command wins on a name clash). */
export function allFlags(spec: CommandSpec): FlagSpec[] {
  const names = new Set(spec.flags.map((flag) => flag.name));
  return [...GLOBAL_FLAGS.filter((flag) => !names.has(flag.name)), ...spec.flags];
}

function invalidValue(flag: FlagSpec, requirement: string): CliError {
  return new CliError("INVALID_FLAG_VALUE", `--${flag.name} ${requirement}.`, { humanDecision: false });
}

function convertOne(flag: FlagSpec, raw: string): string | number {
  if (flag.type === "integer") {
    if (!/^-?\d+$/.test(raw.trim())) throw invalidValue(flag, "must be an integer");
    const value = Number.parseInt(raw.trim(), 10);
    checkRange(flag, value);
    return value;
  }
  if (flag.type === "number") {
    const value = Number(raw.trim());
    if (raw.trim() === "" || !Number.isFinite(value)) throw invalidValue(flag, "must be a number");
    checkRange(flag, value);
    return value;
  }
  if (flag.enum && !flag.enum.includes(raw)) throw invalidValue(flag, `must be one of ${flag.enum.join(", ")}`);
  if (flag.maxLength !== undefined && raw.trim().length > flag.maxLength) {
    throw invalidValue(flag, `must be at most ${flag.maxLength} characters`);
  }
  return raw;
}

function checkRange(flag: FlagSpec, value: number): void {
  if (flag.min !== undefined && value < flag.min) throw invalidValue(flag, `must be at least ${flag.min}`);
  if (flag.max !== undefined && value > flag.max) throw invalidValue(flag, `must be at most ${flag.max}`);
}

function parseErrorToCli(error: unknown): CliError {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  const message = error instanceof Error ? error.message : "Invalid arguments.";
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const flag = /'(-{1,2}[^'=\s]+)/.exec(message)?.[1];
    return new CliError("UNKNOWN_FLAG", flag ? `Unknown flag ${flag}.` : "Unknown flag.", {
      hint: "Run the command with --help to list its flags.",
      humanDecision: false,
    });
  }
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    return new CliError("INVALID_FLAG_VALUE", message.split("\n")[0] ?? message, { humanDecision: false });
  }
  return new CliError("USAGE_ERROR", message.split("\n")[0] ?? message, { humanDecision: false });
}

/** Parsed flags and positionals for one command. */
export interface ParsedArgs {
  flags: Record<string, FlagValue>;
  positionals: string[];
}

/**
 * Parses `tokens` (argv without the command words) for `spec`: strict flags,
 * typed values (integers/numbers converted and range-checked, enums and
 * `maxLength` enforced), defaults applied, positional count checked.
 */
export function parseCommandArgs(spec: CommandSpec, tokens: readonly string[]): ParsedArgs {
  const flagSpecs = allFlags(spec);
  let parsed: { values: Record<string, string | boolean | Array<string | boolean> | undefined>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...tokens],
      options: parseOptions(flagSpecs),
      strict: true,
      allowPositionals: true,
    }) as typeof parsed;
  } catch (error) {
    throw parseErrorToCli(error);
  }
  const flags: Record<string, FlagValue> = {};
  for (const flag of flagSpecs) {
    const raw = parsed.values[flag.name];
    if (raw === undefined) {
      if (flag.default !== undefined) flags[flag.name] = flag.default;
      continue;
    }
    if (flag.type === "boolean") {
      flags[flag.name] = Array.isArray(raw) ? raw.length > 0 : raw === true;
      continue;
    }
    if (Array.isArray(raw)) {
      const converted = raw.map((item) => convertOne(flag, String(item)));
      flags[flag.name] = (flag.type === "string" ? converted.map(String) : converted.map(Number)) as FlagValue;
    } else {
      flags[flag.name] = convertOne(flag, String(raw));
    }
  }
  const positionals = parsed.positionals;
  if (!flags.help) {
    const required = spec.positionals.filter((positional) => positional.required);
    const variadic = spec.positionals.some((positional) => positional.variadic);
    if (positionals.length < required.length) {
      const missing = required[positionals.length];
      throw new CliError("MISSING_ARGUMENT", `Missing <${missing?.name ?? "argument"}>: ${missing?.description ?? ""}`.trim(), {
        hint: `Usage: ${usageLine(spec)}`,
        humanDecision: false,
      });
    }
    if (!variadic && positionals.length > spec.positionals.length) {
      throw new CliError("USAGE_ERROR", `Unexpected argument "${positionals[spec.positionals.length]}".`, {
        hint: `Usage: ${usageLine(spec)}`,
        humanDecision: false,
      });
    }
  }
  return { flags, positionals };
}

/** One-line usage, e.g. `arcopolis agents get <id> [flags]`. */
export function usageLine(spec: CommandSpec): string {
  const parts = [`arcopolis ${spec.name}`];
  for (const positional of spec.positionals) {
    const name = positional.variadic ? `${positional.name}…` : positional.name;
    parts.push(positional.required ? `<${name}>` : `[${name}]`);
  }
  if (spec.flags.length > 0) parts.push("[flags]");
  if (spec.output === "passthrough" && spec.positionals.some((positional) => positional.variadic)) parts.splice(1, 0, "[flags] --");
  return parts.join(" ");
}

/** Human help text for one command. */
export function renderCommandHelp(spec: CommandSpec): string {
  const lines = [`Usage: ${usageLine(spec)}`, "", spec.summary];
  if (spec.description) lines.push("", spec.description);
  lines.push("", `Network: ${spec.network}`);
  if (spec.effects.writes.length) lines.push(`Writes: ${spec.effects.writes.join(", ")}`);
  if (spec.effects.spends.length) lines.push(`Spends: ${spec.effects.spends.join(", ")}`);
  const formatFlag = (flag: FlagSpec): string => {
    const value = flag.type === "boolean" ? "" : ` ${flag.placeholder ?? flag.enum?.join("|") ?? flag.type.toUpperCase()}`;
    const short = flag.short ? `-${flag.short}, ` : "";
    const left = `  ${short}--${flag.name}${value}`;
    const gap = left.length >= 34 ? "  " : " ".repeat(34 - left.length);
    return `${left}${gap}${flag.description}${flag.humanDecision ? " (human decision)" : ""}`;
  };
  if (spec.flags.length) {
    lines.push("", "Flags:");
    for (const flag of spec.flags) lines.push(formatFlag(flag));
  }
  lines.push("", "Global flags:");
  for (const flag of GLOBAL_FLAGS) lines.push(formatFlag(flag));
  lines.push("", `Exit codes: ${[...spec.exitCodes].sort((a, b) => a - b).join(", ")} (arcopolis schema --json explains them)`);
  if (spec.examples?.length) {
    lines.push("", "Examples:");
    for (const example of spec.examples) lines.push(`  ${example}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Human overview listing every command. */
export function renderOverviewHelp(commands: readonly CommandSpec[], version: string): string {
  const width = Math.max(0, ...commands.map((spec) => spec.name.length));
  const lines = [
    `arcopolis ${version}: Arcopolis Public API CLI and MCP server`,
    "",
    "Usage: arcopolis <command> [flags]",
    "",
    "Start with: arcopolis status --json (no network)",
    "",
    "Commands:",
    ...[...commands].sort((a, b) => a.name.localeCompare(b.name)).map((spec) => `  ${spec.name.padEnd(width)}  ${spec.summary}`),
    "",
    "Run arcopolis <command> --help for flags, or arcopolis schema --json for the full contract.",
  ];
  return `${lines.join("\n")}\n`;
}
