#!/usr/bin/env node
/**
 * Installs the latest committed CLI tarball the way users do, with
 * `npx -y --package=<tgz> arcopolis …`, and runs `--version`, `schema --json`,
 * `doctor --json`, and `status --demo --json` (plan §8/§9).
 *
 * Everything runs in a throwaway HOME, ARCOPOLIS_CONFIG_DIR, XDG config, npm
 * cache, and working directory, with every ARCOPOLIS_* and AGNTS_* variable
 * removed, so a developer's own keys and config never reach the run. The only
 * network use is npm fetching the pinned dependency tree from the registry.
 *
 * Checks: each command prints exactly one ok JSON document with exit code 0
 * and makes no requests itself; the version is the manifest's `latest`; the
 * printed schema equals `api_site/cli/schema.json`; and the shrinkwrapped
 * install pulled runtime dependencies only (no TypeScript, ESLint, or Vitest).
 *
 * Usage: node scripts/smoke-tarball.mjs [--tarball PATH|URL]
 *
 * A URL is passed to npm unchanged, so the served tarball is fetched with npm's
 * own User-Agent through the edge, the way users install it.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(cliRoot, "..");
const manifestPath = path.join(repoRoot, "api_site", "downloads", "arcopolis-cli.json");
const publishedSchemaPath = path.join(repoRoot, "api_site", "cli", "schema.json");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const DEV_ONLY = ["typescript", "eslint", "vitest", "tsx"];

function fail(message) {
  process.stderr.write(`smoke:tarball failed: ${message}\n`);
  process.exit(1);
}

const { values } = parseArgs({ options: { tarball: { type: "string" } } });
if (!existsSync(manifestPath)) fail(`${path.relative(repoRoot, manifestPath)} is missing; run node scripts/sync-arcopolis-cli-dist.mjs first.`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const latest = manifest.versions?.find((entry) => entry.version === manifest.latest);
if (!latest) fail(`the manifest has no entry for latest ${JSON.stringify(manifest.latest)}.`);
/** An http(s) value is a served tarball (the deploy's post-publish check): npm fetches it itself. */
const isUrl = /^https?:\/\//i.test(values.tarball ?? "");
const tarball = isUrl ? values.tarball : path.resolve(values.tarball ?? path.join(repoRoot, "api_site", "downloads", latest.file));
if (!isUrl && !existsSync(tarball)) fail(`${tarball} does not exist.`);
if (!values.tarball) {
  const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (digest !== latest.sha256) fail(`${latest.file} does not match the manifest sha256; run node scripts/sync-arcopolis-cli-dist.mjs --check.`);
}

const work = mkdtempSync(path.join(tmpdir(), "arcopolis-cli-smoke-"));
const dirs = {
  home: path.join(work, "home"),
  config: path.join(work, "config"),
  xdg: path.join(work, "xdg"),
  cache: path.join(work, "npm-cache"),
  cwd: path.join(work, "project"),
};
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(ARCOPOLIS_|AGNTS_|npm_config_|NPM_CONFIG_)/.test(name)),
);
Object.assign(env, {
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  ARCOPOLIS_CONFIG_DIR: dirs.config,
  XDG_CONFIG_HOME: dirs.xdg,
  npm_config_cache: dirs.cache,
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
  CI: "1",
});

/** One `npx` run; returns the parsed single JSON document. */
function runCli(args, timeoutMs) {
  const started = Date.now();
  const result = spawnSync(npx, ["-y", `--package=${tarball}`, "arcopolis", ...args], {
    cwd: dirs.cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const label = `arcopolis ${args.join(" ")}`;
  if (result.error) fail(`${label} could not run: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} exited ${result.status}.\nstdout: ${result.stdout.slice(0, 2000)}\nstderr: ${result.stderr.slice(-2000)}`);
  let document;
  try {
    document = JSON.parse(result.stdout);
  } catch {
    fail(`${label} did not print exactly one JSON document.\nstdout: ${result.stdout.slice(0, 2000)}`);
  }
  if (document.ok !== true || document.exitCode !== 0 || document.schemaVersion !== 1) {
    fail(`${label} was not ok: ${JSON.stringify(document).slice(0, 2000)}`);
  }
  if (document.effects?.requests !== 0) fail(`${label} made ${document.effects?.requests} request(s); it must make none.`);
  process.stdout.write(`ok  ${label}  (${Date.now() - started} ms)\n`);
  return document;
}

try {
  const version = runCli(["--version"], 240_000);
  if (version.data?.version !== latest.version) fail(`--version printed ${version.data?.version}, expected ${latest.version}.`);

  const schema = runCli(["schema", "--json"], 60_000);
  if (schema.data?.version !== latest.version) fail(`schema reports version ${schema.data?.version}, expected ${latest.version}.`);
  if (!values.tarball) {
    const published = JSON.parse(readFileSync(publishedSchemaPath, "utf8"));
    if (!isDeepStrictEqual(schema.data, published)) {
      fail("the tarball's `schema --json` data differs from api_site/cli/schema.json; run node scripts/sync-arcopolis-cli-dist.mjs --check.");
    }
  }

  runCli(["doctor", "--json"], 60_000);
  const status = runCli(["status", "--demo", "--json"], 60_000);
  if (status.data?.cliVersion !== latest.version) fail(`status reports cliVersion ${status.data?.cliVersion}, expected ${latest.version}.`);

  const npxDir = path.join(dirs.cache, "_npx");
  const installs = existsSync(npxDir) ? readdirSync(npxDir).map((name) => path.join(npxDir, name, "node_modules")) : [];
  const installed = installs.find((dir) => existsSync(path.join(dir, "arcopolis", "package.json")));
  if (!installed) fail("could not find the npx install of arcopolis in the throwaway npm cache.");
  const installedVersion = JSON.parse(readFileSync(path.join(installed, "arcopolis", "package.json"), "utf8")).version;
  if (installedVersion !== latest.version) fail(`npx installed arcopolis ${installedVersion}, expected ${latest.version}.`);
  if (!existsSync(path.join(installed, "@modelcontextprotocol", "sdk"))) fail("the MCP SDK runtime dependency was not installed.");
  const devInstalled = DEV_ONLY.filter((name) => existsSync(path.join(installed, name)));
  if (devInstalled.length) fail(`the shrinkwrapped install pulled dev-only packages: ${devInstalled.join(", ")}.`);

  process.stdout.write(`smoke:tarball ok: ${isUrl ? tarball : path.basename(tarball)} (arcopolis ${latest.version}) installs with npx and runs offline.\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
