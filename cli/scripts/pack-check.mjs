#!/usr/bin/env node
/**
 * Asserts that `npm pack` would ship only the allowed files: dist/**,
 * README.md, LICENSE, package.json and npm-shrinkwrap.json. Run after
 * `npm run build`.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const output = execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const [pack] = JSON.parse(output);
const files = pack.files.map((file) => file.path);
const allowed = (file) =>
  file.startsWith("dist/") ||
  ["README.md", "LICENSE", "package.json", "npm-shrinkwrap.json"].includes(file);
const unexpected = files.filter((file) => !allowed(file));
const problems = [];
if (unexpected.length > 0) problems.push(`unexpected files: ${unexpected.join(", ")}`);
if (!files.includes("dist/bin.js")) problems.push("dist/bin.js is missing (run npm run build first)");
if (files.some((file) => /\.test\.|\/test\//.test(file))) problems.push("test files would be published");
if (problems.length > 0) {
  process.stderr.write(`pack-check failed: ${problems.join("; ")}\n`);
  process.exit(1);
}
process.stdout.write(`pack-check ok: ${files.length} files, ${pack.size} bytes packed.\n`);
