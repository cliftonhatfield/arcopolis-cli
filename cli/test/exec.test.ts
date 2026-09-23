import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliRuntime } from "../src/cli/main.js";
import { runChild, signalExitCode } from "../src/cli/commands/exec.js";
import { Capture, fakeFetch, fakeKey, json, run, tempDir, type RunResult } from "./helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
let store: string;
let project: string;

const NODE = process.execPath;
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Child script: prints hashes of the injected values (never the values), then the raw read key. */
const REPORT = [
  "const c = require('node:crypto');",
  "const h = (v) => (v ? c.createHash('sha256').update(v).digest('hex') : null);",
  "const e = process.env;",
  "process.stdout.write(JSON.stringify({ base: e.ARCOPOLIS_API_BASE, read: h(e.ARCOPOLIS_API_KEY), visitor: h(e.ARCOPOLIS_VISITOR_API_KEY), agent: e.ARCOPOLIS_VISITOR_AGENT_ID || null }) + '\\n');",
  "process.stdout.write('raw ' + e.ARCOPOLIS_API_KEY + '\\n');",
  "process.stderr.write('err ' + e.ARCOPOLIS_API_KEY + '\\n');",
].join("\n");

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir("arcopolis-exec-"));
  store = path.join(dir, "store");
  project = path.join(dir, "project");
  await mkdir(project, { recursive: true });
  await mkdir(store, { recursive: true, mode: 0o700 });
  const file = path.join(store, "credentials.json");
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      profiles: {
        default: {
          source: "import",
          readKey: { key: fakeKey("a"), origin: "https://api.arcopolis.ai", savedAt: "2026-09-01T00:00:00.000Z" },
          visitor: { agentId: "visitor_ada", key: fakeKey("d"), origin: "https://api.arcopolis.ai", savedAt: "2026-09-01T00:00:00.000Z" },
        },
      },
    }),
  );
  await chmod(file, 0o600);
});
afterEach(async () => {
  await cleanup();
});

async function execRun(argv: string[], overrides: Partial<CliRuntime> = {}, input?: string): Promise<RunResult> {
  const stdout = new Capture();
  const stderr = new Capture();
  const stdin = new PassThrough();
  if (input !== undefined) stdin.end(input);
  const exitCode = await runCli({
    argv,
    env: { ARCOPOLIS_CONFIG_DIR: store },
    cwd: project,
    stdin,
    stdout,
    stderr,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    ...overrides,
  });
  return { exitCode, stdout: stdout.text, stderr: stderr.text, json: null };
}

function firstLine(text: string): Record<string, unknown> {
  return JSON.parse(text.split("\n")[0] ?? "{}") as Record<string, unknown>;
}

describe("exec", () => {
  it("injects the base, both keys, and the agent id; prints nothing itself; redacts the child's output", async () => {
    const fake = fakeFetch(() => json(500, {}));
    const result = await execRun(["exec", "--", NODE, "-e", REPORT], { fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(firstLine(result.stdout)).toEqual({
      base: "https://api.arcopolis.ai/v1",
      read: sha(fakeKey("a")),
      visitor: sha(fakeKey("d")),
      agent: "visitor_ada",
    });
    expect(result.stdout).toContain("raw agnts_aaaa…");
    expect(result.stderr).toContain("err agnts_aaaa…");
    expect(result.stdout).not.toContain(fakeKey("a"));
    expect(result.stderr).not.toContain(fakeKey("a"));
    expect(result.stdout).not.toContain('"schemaVersion"');
  });

  it("an agent marker keeps redaction on even when stdout is a TTY (agent harnesses run commands in a PTY)", async () => {
    const tty = { stdinIsTTY: true, stdoutIsTTY: true };
    const agent = await execRun(["exec", "--", NODE, "-e", REPORT], { ...tty, env: { ARCOPOLIS_CONFIG_DIR: store, CLAUDECODE: "1" } });
    expect(agent.exitCode).toBe(0);
    expect(agent.stdout).toContain("raw agnts_aaaa…");
    expect(agent.stdout).not.toContain(fakeKey("a"));
    const noInput = await execRun(["exec", "--no-input", "--", NODE, "-e", REPORT], tty);
    expect(noInput.stdout).not.toContain(fakeKey("a"));
    const human = await execRun(["exec", "--", NODE, "-e", REPORT], tty);
    expect(human.stdout).toContain(`raw ${fakeKey("a")}`);
  });

  it("a key in a line longer than the redactor's buffer never comes out whole", async () => {
    const script = "process.stdout.write('x'.repeat(131062)+process.env.ARCOPOLIS_API_KEY+'z'.repeat(200000)+'\\n')";
    const result = await execRun(["exec", "--", NODE, "-e", script]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.includes(fakeKey("a"))).toBe(false);
    expect(result.stdout.includes("a".repeat(40))).toBe(false);
  });

  it("--raw-output leaves the child's output alone", async () => {
    const result = await execRun(["exec", "--raw-output", "--", NODE, "-e", REPORT]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`raw ${fakeKey("a")}`);
  });

  it("--visitor also sets ARCOPOLIS_API_KEY to the drive key", async () => {
    const result = await execRun(["exec", "--visitor", "--", NODE, "-e", REPORT]);
    expect(firstLine(result.stdout)).toMatchObject({ read: sha(fakeKey("d")), visitor: sha(fakeKey("d")), agent: "visitor_ada" });
  });

  it("exits with the child's exit code", async () => {
    const result = await execRun(["exec", "--", NODE, "-e", "process.exit(7)"]);
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("");
  });

  it("forwards stdin to the child", async () => {
    const script = "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write('got '+s))";
    const result = await execRun(["exec", "--", NODE, "-e", script], {}, "hello\n");
    expect(result.stdout).toContain("got hello");
  });

  it("missing credentials exit 3 before spawning", async () => {
    const marker = path.join(dir, "spawned");
    const result = await run(["exec", "--", NODE, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], {
      env: { ARCOPOLIS_CONFIG_DIR: path.join(dir, "empty") },
      cwd: project,
    });
    expect(result.exitCode).toBe(3);
    expect(result.json).toMatchObject({ ok: false, command: "exec", error: { code: "NO_CREDENTIALS" }, next: [{ command: "arcopolis setup --json" }] });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("--visitor without a visitor key exits 3", async () => {
    const result = await run(["exec", "--visitor", "--", NODE, "-e", "0"], {
      env: { ARCOPOLIS_CONFIG_DIR: path.join(dir, "empty"), ARCOPOLIS_API_KEY: fakeKey("b") },
      cwd: project,
    });
    expect(result.exitCode).toBe(3);
    expect(result.json).toMatchObject({ error: { code: "NO_CREDENTIALS" } });
  });

  it("never hands a stored key to a custom base", async () => {
    const result = await run(["exec", "--", NODE, "-e", "0"], {
      env: { ARCOPOLIS_CONFIG_DIR: store, ARCOPOLIS_API_BASE: "https://staging.example.com/v1", ARCOPOLIS_ALLOW_CUSTOM_BASE: "1" },
      cwd: project,
    });
    expect(result.exitCode).toBe(3);
    expect(result.json).toMatchObject({ error: { code: "STORED_KEY_ORIGIN_MISMATCH" } });
  });

  it("an unknown command is an error document (exit 2), not a crash", async () => {
    const result = await run(["exec", "--", "arcopolis-test-no-such-command-xyz"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(result.exitCode).toBe(2);
    expect(result.json).toMatchObject({ error: { code: "COMMAND_NOT_FOUND", category: "invalid_input" } });
  });

  it("needs a command", async () => {
    const result = await run(["exec"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(result.exitCode).toBe(2);
    expect(result.json).toMatchObject({ error: { code: "MISSING_ARGUMENT" } });
  });

  it("demo mode reports what would run and spawns nothing", async () => {
    const marker = path.join(dir, "spawned");
    const result = await run(["exec", "--demo", "--", NODE, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], {
      env: { ARCOPOLIS_CONFIG_DIR: store },
      cwd: project,
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      meta: { demo: true },
      data: { spawned: false, injected: ["ARCOPOLIS_API_BASE", "ARCOPOLIS_API_KEY", "ARCOPOLIS_VISITOR_API_KEY", "ARCOPOLIS_VISITOR_AGENT_ID"] },
    });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("runChild signal forwarding", () => {
  const base = (signals: EventEmitter, forwardTerminalSignals: boolean, onSpawn: () => void): Parameters<typeof runChild>[0] => ({
    command: NODE,
    args: ["-e", "setInterval(() => {}, 1000)"],
    env: {},
    cwd: project,
    redactOutput: false,
    stdin: new PassThrough(),
    stdout: new Capture(),
    stderr: new Capture(),
    inheritStdio: { stdin: false, stdout: false, stderr: false },
    signalSource: signals,
    forwardTerminalSignals,
    onSpawn,
  });

  it("forwards SIGTERM and exits 128 + signal", async () => {
    const signals = new EventEmitter();
    const code = await runChild(base(signals, true, () => setTimeout(() => signals.emit("SIGTERM"), 100)));
    expect(code).toBe(signalExitCode("SIGTERM"));
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("does not re-send SIGINT when the terminal already delivered it", async () => {
    const signals = new EventEmitter();
    const code = await runChild(
      base(signals, false, () => {
        setTimeout(() => signals.emit("SIGINT"), 50);
        setTimeout(() => signals.emit("SIGTERM"), 250);
      }),
    );
    expect(code).toBe(signalExitCode("SIGTERM"));
  });
});
