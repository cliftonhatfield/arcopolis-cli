/**
 * Source guards over every file in `cli/src/` (plan §2.9 and §8): the CLI
 * has no admin surface, never writes to stdout behind the runner's back,
 * and every error code it throws is in the published exit-code table.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isKnownCode } from "../src/core/errors.js";
import { CLI_ROOT } from "./helpers.js";

const SRC = path.join(CLI_ROOT, "src");

/** Every file under `dir` (any extension), as absolute paths. */
function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? allFiles(full) : [full];
  });
}

const files = allFiles(SRC);
const tsFiles = files.filter((file) => file.endsWith(".ts"));
const relative = (file: string): string => path.relative(CLI_ROOT, file);

describe("source guards (cli/src)", () => {
  it("scans a non-trivial tree", () => {
    expect(tsFiles.length).toBeGreaterThan(20);
  });

  it("no admin fields anywhere in src/ (any file type)", () => {
    const forbidden = /adminApiEnabled|adminScopes|allowedAdmin|allowedService|allowedSubjectTypes/;
    const offenders = files.filter((file) => forbidden.test(readFileSync(file, "utf8"))).map(relative);
    expect(offenders).toEqual([]);
  });

  it("never reads admin credentials from the environment", () => {
    const offenders = tsFiles.filter((file) => /AGNTS_ADMIN_/.test(readFileSync(file, "utf8"))).map(relative);
    expect(offenders).toEqual([]);
  });

  it("no console.log / console.info in src/ (stdout is one document, or JSON-RPC under mcp)", () => {
    const offenders = tsFiles.filter((file) => /\bconsole\.(log|info)\s*\(/.test(readFileSync(file, "utf8"))).map(relative);
    expect(offenders).toEqual([]);
  });

  it("never prints the unpinned `npx arcopolis` run form (only `arcopolis@<version>`)", () => {
    // `npx arcopolis` / `npx -y arcopolis` / `npx arcopolis@latest` run whatever npm resolves that day.
    const unpinned = /npx(\s+-y)?\s+arcopolis(?!@(?:\d+\.\d+\.\d+|<version>))(?![\w-])/;
    const offenders = files.filter((file) => unpinned.test(readFileSync(file, "utf8"))).map(relative);
    expect(offenders).toEqual([]);
  });

  it("builds the npx package spec in one place (npmSpec), never as a literal", () => {
    const literal = /["'`]arcopolis@(\d|\$\{)/;
    const offenders = tsFiles
      .filter((file) => !file.endsWith(path.join("init", "init.ts")))
      .filter((file) => literal.test(readFileSync(file, "utf8")))
      .map(relative);
    expect(offenders).toEqual([]);
  });

  it("every literal code thrown as a CliError is in the exit-code table", () => {
    const unknown: string[] = [];
    for (const file of tsFiles) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/new CliError\(\s*"([A-Z][A-Z0-9_]*)"/g)) {
        const code = match[1] ?? "";
        if (!isKnownCode(code)) unknown.push(`${relative(file)}: ${code}`);
      }
    }
    expect(unknown, "add these codes to CATEGORY_CODES in src/core/errors.ts").toEqual([]);
  });
});
