#!/usr/bin/env node
/**
 * Copies the published OpenAPI contract (api_site/openapi.json at the repository root) into the
 * CLI package (src/generated/openapi.json) so the CLI can validate `api get`
 * paths and describe operations offline.
 *
 * Usage:
 *   node scripts/snapshot-openapi.mjs          write the snapshot
 *   node scripts/snapshot-openapi.mjs --check  exit 1 when the snapshot drifted
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, "../../api_site/openapi.json");
const target = path.resolve(here, "../src/generated/openapi.json");
const check = process.argv.includes("--check");

const sourceBytes = await readFile(source);
JSON.parse(sourceBytes.toString("utf8"));

if (check) {
  let targetBytes = null;
  try {
    targetBytes = await readFile(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!targetBytes || !targetBytes.equals(sourceBytes)) {
    process.stderr.write(
      "src/generated/openapi.json is out of date with api_site/openapi.json. Run: node scripts/snapshot-openapi.mjs\n",
    );
    process.exit(1);
  }
  process.stdout.write("OpenAPI snapshot is current.\n");
} else {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, sourceBytes);
  process.stdout.write(`Wrote ${path.relative(process.cwd(), target)} (${sourceBytes.length} bytes).\n`);
}
