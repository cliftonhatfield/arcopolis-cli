/**
 * Real-process check of the non-interactive contract: each command runs as
 * its own `node` process with a piped stdin that is never closed (so any
 * attempt to read it would hang), against a loopback HTTP server standing in
 * for both planes. Commands that need a person must exit 10 promptly.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeKey, tempDir } from "./helpers.js";

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(CLI_ROOT, "src", "bin.ts");
const TSX = pathToFileURL(path.join(CLI_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const KILL_AFTER_MS = 30_000;

let server: Server;
let origin: string;
const requests: string[] = [];
let dir: string;
let cleanup: () => Promise<void>;
let store: string;
let project: string;

beforeAll(async () => {
  ({ dir, cleanup } = await tempDir("arcopolis-subprocess-"));
  store = path.join(dir, "store");
  project = path.join(dir, "project");
  await mkdir(project, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: project, stdio: "ignore" });
  await mkdir(store, { recursive: true, mode: 0o700 });
  const file = path.join(store, "credentials.json");
  server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const body =
      request.url === "/_developer/signup"
        ? { data: { open: true, termsVersion: "2026-09-16", visitorWorlds: { open: 1 } } }
        : { error: { code: "NOT_FOUND", message: "unexpected" } };
    response.writeHead(request.url === "/_developer/signup" ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      profiles: { default: { source: "import", readKey: { key: fakeKey("a"), origin, savedAt: "2026-09-01T00:00:00.000Z" } } },
    }),
  );
  await chmod(file, 0o600);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  killed: boolean;
}

function runBin(args: string[], configDir = store): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", TSX, BIN, ...args], {
      cwd: project,
      env: {
        PATH: process.env.PATH ?? "",
        ARCOPOLIS_CONFIG_DIR: configDir,
        ARCOPOLIS_API_BASE: `${origin}/v1`,
        ARCOPOLIS_DEVELOPER_BASE: `${origin}/_developer`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, KILL_AFTER_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, ms: Date.now() - started, killed });
    });
  });
}

function doc(result: ProcessResult): Record<string, unknown> {
  const lines = result.stdout.split("\n").filter((line) => line.trim());
  expect(lines, result.stderr).toHaveLength(1);
  return JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
}

describe("non-interactive subprocesses (stdin piped and never closed)", () => {
  it("every human step exits 10 without reading stdin; status and doctor make no request", { timeout: 120_000 }, async () => {
    const [setup, importKey, forget, envWrite, status, doctor] = await Promise.all([
      runBin(["setup", "--json"], path.join(dir, "empty-store")),
      runBin(["auth", "import", "--json"]),
      runBin(["auth", "forget", "--json"]),
      runBin(["env", "write", ".env.arcopolis", "--json"]),
      runBin(["status", "--json"]),
      runBin(["doctor", "--json"]),
    ]);
    for (const result of [setup, importKey, forget, envWrite, status, doctor]) {
      expect(result.killed, result.stderr).toBe(false);
      expect(result.stderr).not.toContain(fakeKey("a"));
      expect(result.stdout).not.toContain(fakeKey("a"));
    }
    expect(setup.exitCode).toBe(10);
    expect(doc(setup)).toMatchObject({ error: { code: "HUMAN_SETUP_REQUIRED" }, humanAction: { mode: "guided" } });
    expect(importKey.exitCode).toBe(10);
    expect(doc(importKey)).toMatchObject({ error: { code: "INPUT_REQUIRED" } });
    expect(forget.exitCode).toBe(10);
    expect(doc(forget)).toMatchObject({ error: { code: "CONFIRMATION_REQUIRED" } });
    expect(envWrite.exitCode).toBe(10);
    expect(doc(envWrite)).toMatchObject({ error: { code: "CONFIRMATION_REQUIRED" } });
    expect(status.exitCode).toBe(0);
    expect(doc(status)).toMatchObject({ data: { read: { configured: true, keyPrefix: "agnts_aaaa…" } }, effects: { requests: 0 } });
    expect(doctor.exitCode).toBe(0);
    expect(doc(doctor)).toMatchObject({ data: { requests: 0 }, effects: { requests: 0 } });
    // Only setup reached the network: its liveness probe and the grant start this fake refuses (404, as a
    // backend without the grant routes does), so it fell back to the guided steps. No data-plane request.
    expect(requests).toEqual(["GET /_developer/signup", "POST /_developer/cli/grants"]);
  });
});
