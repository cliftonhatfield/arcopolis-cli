/**
 * `arcopolis schema [--command NAME]` (plan §4.9): the registry as one
 * document (commands, flags, effects, exit codes, env vars, files). Offline.
 */
import { CliError } from "../../core/errors.js";
import { defineCommand, flagString, objectSchema, type CommandSpec, type DocumentView } from "../spec.js";

interface SchemaCommandEntry {
  name: string;
  summary: string;
  network: string;
  confirmation: string;
}

function renderSchemaHuman(view: DocumentView): string {
  const doc = view.data as { version?: string; commands?: SchemaCommandEntry[]; exitCodes?: Record<string, string> };
  const lines = [`arcopolis ${doc.version ?? ""}`.trim(), "", "Commands:"];
  const commands = doc.commands ?? [];
  const width = Math.max(0, ...commands.map((entry) => entry.name.length));
  for (const entry of commands) {
    lines.push(`  ${entry.name.padEnd(width)}  ${entry.summary}`);
  }
  lines.push("", "Exit codes:");
  for (const [exit, category] of Object.entries(doc.exitCodes ?? {})) lines.push(`  ${exit.padStart(2)}  ${category}`);
  lines.push("", "Full contract: arcopolis schema --json");
  return `${lines.join("\n")}\n`;
}

export const commands: CommandSpec[] = [
  defineCommand({
    name: "schema",
    summary: "Describe every command, flag, side effect, exit code, environment variable, and file",
    phase: 1,
    credentials: "none",
    confirmation: "none",
    network: "none",
    effects: { writes: [], spends: [] },
    flags: [{ name: "command", type: "string", placeholder: "NAME", description: "Only this command, e.g. \"visitor act\"." }],
    positionals: [],
    errors: ["UNKNOWN_COMMAND"],
    exitCodes: [0, 2],
    outputSchema: objectSchema(
      {
        schemaVersion: { const: 1 },
        cli: { const: "arcopolis" },
        version: { type: "string" },
        exitCodes: { type: "object", additionalProperties: { type: "string" } },
        exitCodeTable: { type: "array" },
        globalFlags: { type: "array" },
        env: { type: "array" },
        files: { type: "array" },
        definitions: { type: "object" },
        commands: { type: "array" },
      },
      ["schemaVersion", "cli", "version", "exitCodes", "commands"],
    ),
    examples: ["arcopolis schema --json", "arcopolis schema --command \"visitor act\" --json"],
    async run(ctx) {
      const doc = ctx.registry.schemaDocument();
      const only = flagString(ctx.flags, "command")?.trim().replace(/\s+/g, " ");
      if (only) {
        const spec = ctx.registry.find(only);
        if (!spec) {
          throw new CliError("UNKNOWN_COMMAND", `No command named "${only}".`, {
            hint: "Run arcopolis schema --json to list every command.",
            humanDecision: false,
          });
        }
        return { data: { ...doc, commands: [ctx.registry.describe(spec)] } };
      }
      return { data: doc };
    },
    renderHuman: renderSchemaHuman,
  }),
];
