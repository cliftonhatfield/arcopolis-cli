/**
 * The command registry (plan §4.9): every command module's `commands` array,
 * plus lookup and the schema document. Parsing lives in `parse.ts`, the
 * runner in `main.ts`.
 */
import { commands as apiCommands } from "./commands/api.js";
import { commands as authCommands } from "./commands/auth.js";
import { commands as doctorCommands } from "./commands/doctor.js";
import { commands as envCommands } from "./commands/env.js";
import { commands as execCommands } from "./commands/exec.js";
import { commands as initCommands } from "./commands/init.js";
import { commands as mcpCommands } from "./commands/mcp.js";
import { commands as portalCommands } from "./commands/portal.js";
import { commands as readCommands } from "./commands/read.js";
import { commands as schemaCommands } from "./commands/schema.js";
import { commands as setupCommands } from "./commands/setup.js";
import { commands as statusCommands } from "./commands/status.js";
import { commands as versionCommands } from "./commands/version.js";
import { commands as visitorCommands } from "./commands/visitor.js";
import { buildSchemaDocument, describeCommand } from "./schemaDoc.js";
import type { CommandSpec, RegistryView } from "./spec.js";

export type * from "./spec.js";

/** Every registered command, in registration order. */
export const COMMANDS: readonly CommandSpec[] = [
  ...statusCommands,
  ...doctorCommands,
  ...setupCommands,
  ...authCommands,
  ...initCommands,
  ...schemaCommands,
  ...versionCommands,
  ...portalCommands,
  ...apiCommands,
  ...readCommands,
  ...visitorCommands,
  ...execCommands,
  ...envCommands,
  ...mcpCommands,
];

/** Builds a registry view over a command list (tests pass their own list). */
export function createRegistry(commands: readonly CommandSpec[], version: string): RegistryView {
  const byName = new Map<string, CommandSpec>();
  for (const spec of commands) {
    if (byName.has(spec.name)) throw new Error(`Duplicate command name: ${spec.name}`);
    byName.set(spec.name, spec);
  }
  return {
    commands,
    find: (name: string): CommandSpec | undefined => byName.get(name.trim().replace(/\s+/g, " ")),
    schemaDocument: (): Record<string, unknown> => buildSchemaDocument(commands, version),
    describe: (spec: CommandSpec): Record<string, unknown> => describeCommand(spec),
  };
}

/** Longest registered command name made of the leading words (up to 3). */
export function matchCommand(registry: RegistryView, words: readonly string[]): { spec: CommandSpec; length: number } | null {
  for (let length = Math.min(3, words.length); length >= 1; length -= 1) {
    const spec = registry.find(words.slice(0, length).join(" "));
    if (spec) return { spec, length };
  }
  return null;
}
