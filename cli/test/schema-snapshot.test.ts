/**
 * Schema snapshot (plan §4.9 and §8): `arcopolis schema --json` describes
 * every command with effects, exit codes, and an `outputSchema`, and every
 * flag and positional is described. The machine contract (names, flags,
 * confirmations, effects, exit codes, the exit-code table) is pinned in a
 * committed file snapshot, so a change to it shows up in review. Additive
 * changes are fine; update the snapshot with `npx vitest run -u` and say so
 * in the PR. Removing or renaming anything is a major-version change.
 */
import { describe, expect, it } from "vitest";
import { EXIT_CODES, isKnownCode, lookupCodeCategory } from "../src/core/errors.js";
import { run } from "./helpers.js";

interface FlagEntry {
  name: string;
  type: string;
  description: string;
  humanDecision?: boolean;
  enum?: string[];
  min?: number;
  max?: number;
  maxLength?: number;
  multiple?: boolean;
}

interface CommandEntry {
  name: string;
  summary: string;
  phase: number;
  credentials: string;
  confirmation: string;
  network: string;
  effects: { writes: string[]; spends: string[] };
  flags: FlagEntry[];
  positionals: Array<{ name: string; description: string; required?: boolean; variadic?: boolean }>;
  errors: string[];
  exitCodes: number[];
  outputSchema: Record<string, unknown>;
}

interface SchemaDocument {
  schemaVersion: number;
  exitCodes: Record<string, string>;
  exitCodeTable: Array<{ exit: number; category: string; codes: string[] }>;
  commands: CommandEntry[];
}

async function schemaDocument(): Promise<SchemaDocument> {
  const result = await run(["schema", "--json"]);
  expect(result.exitCode).toBe(0);
  return result.json?.data as SchemaDocument;
}

const DOCUMENTED_EXITS = new Set<number>(Object.values(EXIT_CODES));

describe("schema snapshot", () => {
  it("every command has effects, exitCodes, and an outputSchema, and describes every flag and positional", async () => {
    const doc = await schemaDocument();
    expect(doc.commands.length).toBeGreaterThan(40);
    for (const command of doc.commands) {
      const label = command.name;
      expect(command.summary.length, label).toBeGreaterThan(0);
      expect(command.effects, label).toEqual({ writes: expect.any(Array), spends: expect.any(Array) });
      expect(command.exitCodes.length, label).toBeGreaterThan(0);
      expect(command.exitCodes, label).toContain(0);
      for (const exit of command.exitCodes) expect(DOCUMENTED_EXITS.has(exit), `${label} exit ${exit}`).toBe(true);
      expect(command.outputSchema, label).toMatchObject({ type: expect.anything() });
      expect(["none", "execute", "yes", "human_approval"], label).toContain(command.confirmation);
      expect(["none", "read", "visitor", "stored"], label).toContain(command.credentials);
      expect(command.network.length, label).toBeGreaterThan(0);
      for (const flag of command.flags) {
        expect(flag.name, label).toMatch(/^--[a-z][a-z0-9-]*$/);
        expect(flag.description.length, `${label} ${flag.name}`).toBeGreaterThan(0);
      }
      for (const positional of command.positionals) expect(positional.description.length, `${label} <${positional.name}>`).toBeGreaterThan(0);
      if (command.effects.writes.length > 0 && command.confirmation === "execute") {
        expect(command.flags.find((flag) => flag.name === "--execute"), label).toMatchObject({ humanDecision: true });
      }
    }
  });

  it("every documented error code is in the exit-code table, and its exit is in that command's exitCodes", async () => {
    const doc = await schemaDocument();
    const problems: string[] = [];
    for (const command of doc.commands) {
      for (const code of command.errors) {
        if (code === "IDEMPOTENCY_IN_PROGRESS") continue;
        if (!isKnownCode(code)) {
          problems.push(`${command.name}: ${code} is not in the table`);
          continue;
        }
        const category = lookupCodeCategory(code);
        if (category && !command.exitCodes.includes(EXIT_CODES[category])) problems.push(`${command.name}: ${code} exits ${EXIT_CODES[category]}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("the machine contract matches the committed snapshot", async () => {
    const doc = await schemaDocument();
    const contract = {
      schemaVersion: doc.schemaVersion,
      exitCodes: doc.exitCodes,
      exitCodeTable: doc.exitCodeTable.map((row) => ({ exit: row.exit, category: row.category, codes: row.codes })),
      commands: [...doc.commands]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((command) => ({
          name: command.name,
          phase: command.phase,
          credentials: command.credentials,
          confirmation: command.confirmation,
          network: command.network,
          effects: command.effects,
          exitCodes: command.exitCodes,
          positionals: command.positionals.map((positional) => ({
            name: positional.name,
            required: positional.required ?? false,
            variadic: positional.variadic ?? false,
          })),
          flags: command.flags.map((flag) => ({
            name: flag.name,
            type: flag.type,
            ...(flag.humanDecision ? { humanDecision: true } : {}),
            ...(flag.enum ? { enum: flag.enum } : {}),
            ...(flag.min !== undefined ? { min: flag.min } : {}),
            ...(flag.max !== undefined ? { max: flag.max } : {}),
            ...(flag.maxLength !== undefined ? { maxLength: flag.maxLength } : {}),
            ...(flag.multiple ? { multiple: true } : {}),
          })),
        })),
    };
    await expect(`${JSON.stringify(contract, null, 2)}\n`).toMatchFileSnapshot("./__snapshots__/schema-contract.json");
  });
});
