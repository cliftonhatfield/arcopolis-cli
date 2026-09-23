import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliRuntime } from "../src/cli/main.js";
import { Capture, fakeFetch, fakeKey, json, run, tempDir, type RunResult } from "./helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
let store: string;
let project: string;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir("arcopolis-auth-"));
  store = path.join(dir, "store");
  project = path.join(dir, "project");
  await mkdir(project, { recursive: true });
});
afterEach(async () => {
  await cleanup();
});

const V1_OK = (): Response => json(200, { name: "AGNTS Public API", version: "1.0.0" });

async function readCredentials(): Promise<{ profiles: Record<string, Record<string, Record<string, unknown> | undefined>> }> {
  return JSON.parse(await readFile(path.join(store, "credentials.json"), "utf8")) as {
    profiles: Record<string, Record<string, Record<string, unknown> | undefined>>;
  };
}

async function seed(profiles: Record<string, unknown>): Promise<void> {
  await mkdir(store, { recursive: true, mode: 0o700 });
  const file = path.join(store, "credentials.json");
  await writeFile(file, JSON.stringify({ schemaVersion: 1, profiles }));
  await chmod(file, 0o600);
}

/** In-process run with stdin carrying `input` and then closing (non-TTY). */
async function runWithStdin(argv: string[], input: string, overrides: Partial<CliRuntime> = {}): Promise<RunResult> {
  const stdout = new Capture();
  const stderr = new Capture();
  const stdin = new PassThrough();
  stdin.end(input);
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
  const line = stdout.text.trim();
  return { exitCode, stdout: stdout.text, stderr: stderr.text, json: line ? (JSON.parse(line) as Record<string, unknown>) : null };
}

/** Stderr sink that answers each prompt (`… (input is hidden): ` or `[y/N] `) from a queue. */
class PromptAnswerer extends Writable {
  text = "";
  constructor(
    private readonly stdin: PassThrough,
    private readonly answers: string[],
  ) {
    super();
  }
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.text += text;
    if (/\(input is hidden\): $|\[y\/N\] $/.test(text)) {
      const answer = this.answers.shift();
      if (answer !== undefined) setImmediate(() => this.stdin.write(`${answer}\n`));
    }
    callback();
  }
}

/** In-process run on a (simulated) interactive terminal. */
async function runTty(argv: string[], answers: string[], overrides: Partial<CliRuntime> = {}): Promise<RunResult> {
  const stdout = new Capture();
  const stdin = new PassThrough();
  const stderr = new PromptAnswerer(stdin, answers);
  const exitCode = await runCli({
    argv,
    env: { ARCOPOLIS_CONFIG_DIR: store },
    cwd: project,
    stdin,
    stdout,
    stderr,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    ...overrides,
  });
  const line = stdout.text.trim();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = line ? (JSON.parse(line) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  return { exitCode, stdout: stdout.text, stderr: stderr.text, json: parsed };
}

describe("auth import", () => {
  it("--stdin stores the key at 0600 in a 0700 store, verifies with one GET /v1, and never prints the key", async () => {
    const fake = fakeFetch(V1_OK);
    const result = await runWithStdin(["auth", "import", "--stdin", "--json"], `${fakeKey("a")}\n`, { fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      data: { profile: "default", kind: "read", keyPrefix: "agnts_aaaa…", source: "stdin", stored: true, verified: true, fileMode: "0600" },
      effects: { network: ["data"], requests: 1, writes: ["credential_store"], secretsWritten: ["credential_store:readKey"], spends: { rateLimit: 1 } },
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe("https://api.arcopolis.ai/v1");
    expect(fake.calls[0]?.init.method).toBe("GET");
    expect(fake.calls[0]?.headers["x-api-key"]).toBe(fakeKey("a"));
    expect(result.stdout).not.toContain(fakeKey("a"));
    expect(result.stderr).not.toContain(fakeKey("a"));
    expect((await stat(path.join(store, "credentials.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(store)).mode & 0o777).toBe(0o700);
    const saved = await readCredentials();
    expect(saved.profiles.default?.readKey).toMatchObject({ key: fakeKey("a"), origin: "https://api.arcopolis.ai", lastVerifiedAt: expect.any(String) });
    expect(saved.profiles.default?.terms).toMatchObject({ acceptedVia: "import" });
  });

  it("--from-env NAME --no-verify stores with zero requests", async () => {
    const fake = fakeFetch(V1_OK);
    const result = await run(["auth", "import", "--from-env", "MY_SECRET", "--no-verify"], {
      env: { ARCOPOLIS_CONFIG_DIR: store, MY_SECRET: fakeKey("c") },
      cwd: project,
      fetchImpl: fake.fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(result.json).toMatchObject({ data: { source: "env", verified: false, verification: { skipped: "no_verify" } }, effects: { requests: 0 } });
    expect((await readCredentials()).profiles.default?.readKey?.key).toBe(fakeKey("c"));
  });

  it("rejects a malformed key (exit 2) without echoing it", async () => {
    const result = await runWithStdin(["auth", "import", "--stdin"], "agnts_not-a-real-key-value\n");
    expect(result.exitCode).toBe(2);
    expect(result.json).toMatchObject({ error: { code: "INVALID_KEY_FORMAT" } });
    expect(result.stdout).not.toContain("not-a-real-key-value");
  });

  it("never prompts without a TTY: exit 10 INPUT_REQUIRED and zero requests", async () => {
    const fake = fakeFetch(V1_OK);
    const started = Date.now();
    const result = await run(["auth", "import"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: fake.fetchImpl });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.exitCode).toBe(10);
    expect(result.json).toMatchObject({ error: { code: "INPUT_REQUIRED", category: "needs_human", humanDecision: true } });
    expect(result.stderr).not.toContain("Paste");
    expect(fake.calls).toHaveLength(0);
  });

  it("an agent marker makes a TTY session non-interactive too", async () => {
    const result = await runTty(["auth", "import", "--json"], [fakeKey("a")], { env: { ARCOPOLIS_CONFIG_DIR: store, CLAUDECODE: "1" } });
    expect(result.exitCode).toBe(10);
    expect(result.stderr).not.toContain("Paste");
  });

  it("a key the API rejects (401) is not kept and exits 3", async () => {
    await seed({ default: { source: "import", readKey: { key: fakeKey("1"), origin: "https://api.arcopolis.ai", savedAt: "2026-09-01T00:00:00.000Z" } } });
    const fake = fakeFetch(() => json(401, { error: { code: "INVALID_API_KEY", message: "Invalid API key" } }));
    const result = await runWithStdin(["auth", "import", "--stdin"], fakeKey("2"), { fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(3);
    expect(result.json).toMatchObject({ error: { code: "INVALID_API_KEY", category: "auth" } });
    expect((await readCredentials()).profiles.default?.readKey?.key).toBe(fakeKey("1"));
    expect(result.stdout).not.toContain(fakeKey("2"));
  });

  it("a rejected key in a new profile removes the profile again", async () => {
    const fake = fakeFetch(() => json(401, { error: { code: "KEY_REVOKED", message: "revoked" } }));
    const result = await runWithStdin(["auth", "import", "--stdin", "--profile", "work"], fakeKey("2"), { fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(3);
    expect((await readCredentials()).profiles.work).toBeUndefined();
  });

  it("a transient verification failure keeps the key, reports it unverified, and warns", async () => {
    const fake = fakeFetch(() => json(503, { error: { code: "INTERNAL_ERROR", message: "down" } }));
    const result = await runWithStdin(["auth", "import", "--stdin"], fakeKey("3"), { fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      data: { stored: true, verified: false, verification: { error: { code: "INTERNAL_ERROR", exitCode: 12 } } },
      warnings: [{ code: "KEY_NOT_VERIFIED" }],
    });
    expect((await readCredentials()).profiles.default?.readKey?.key).toBe(fakeKey("3"));
  });

  it("does not verify when an environment key of the same kind overrides the store", async () => {
    const fake = fakeFetch(V1_OK);
    const result = await runWithStdin(["auth", "import", "--stdin"], fakeKey("4"), {
      env: { ARCOPOLIS_CONFIG_DIR: store, ARCOPOLIS_API_KEY: fakeKey("5") },
      fetchImpl: fake.fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(result.json).toMatchObject({ data: { verified: false, verification: { skipped: "env_override", variable: "ARCOPOLIS_API_KEY" } } });
    expect((result.json?.warnings as Array<{ code: string }>).map((warning) => warning.code)).toContain("ENV_OVERRIDES_STORE");
  });

  it("--visitor needs --agent (exit 2) and stores the visitor record with it", async () => {
    expect((await runWithStdin(["auth", "import", "--visitor", "--stdin"], fakeKey("6"))).json).toMatchObject({
      exitCode: 2,
      error: { code: "MISSING_ARGUMENT" },
    });
    expect((await runWithStdin(["auth", "import", "--agent", "visitor_ada", "--stdin"], fakeKey("6"))).exitCode).toBe(2);
    const fake = fakeFetch(V1_OK);
    const result = await runWithStdin(["auth", "import", "--visitor", "--agent", "visitor_ada", "--world", "world_7", "--stdin"], fakeKey("6"), {
      fetchImpl: fake.fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      data: { kind: "visitor", agentId: "visitor_ada", worldId: "world_7", verified: true },
      effects: { secretsWritten: ["credential_store:visitorKey"] },
    });
    expect(fake.calls[0]?.headers["x-api-key"]).toBe(fakeKey("6"));
    expect((await readCredentials()).profiles.default?.visitor).toMatchObject({ agentId: "visitor_ada", worldId: "world_7", key: fakeKey("6") });
  });

  it("a key passed as an argument is refused before anything runs", async () => {
    const result = await run(["auth", "import", "--from-env", fakeKey("7")], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(result.exitCode).toBe(2);
    expect(result.json).toMatchObject({ error: { code: "SECRET_IN_ARGUMENTS" } });
    expect(result.stdout).not.toContain(fakeKey("7"));
  });

  it("reads the key from a hidden prompt in a TTY", async () => {
    const fake = fakeFetch(V1_OK);
    const result = await runTty(["auth", "import", "--json"], [fakeKey("8")], { fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Paste the read key (input is hidden):");
    expect(result.stderr).not.toContain(fakeKey("8"));
    expect(result.json).toMatchObject({ data: { source: "prompt", verified: true } });
    expect((await readCredentials()).profiles.default?.readKey?.key).toBe(fakeKey("8"));
  });

  it("demo mode writes nothing", async () => {
    const result = await runWithStdin(["auth", "import", "--stdin", "--demo"], fakeKey("9"));
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ meta: { demo: true }, data: { stored: false, verification: { skipped: "demo" } } });
    await expect(stat(path.join(store, "credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("auth status", () => {
  it("shows sources and prefixes only", async () => {
    await seed({
      default: {
        source: "import",
        readKey: { key: fakeKey("a"), tier: 2, origin: "https://api.arcopolis.ai", savedAt: "2026-09-01T00:00:00.000Z" },
        visitor: { agentId: "visitor_ada", key: fakeKey("d"), origin: "https://api.arcopolis.ai", savedAt: "2026-09-01T00:00:00.000Z" },
      },
    });
    const result = await run(["auth", "status"], {
      env: { ARCOPOLIS_CONFIG_DIR: store, ARCOPOLIS_VISITOR_API_KEY: fakeKey("e") },
      cwd: project,
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      data: {
        profile: { name: "default", source: "default", exists: true },
        profiles: ["default"],
        read: { configured: true, keyPrefix: "agnts_aaaa…", source: "store", tier: 2 },
        visitor: { configured: true, keyPrefix: "agnts_eeee…", source: "env", variable: "ARCOPOLIS_VISITOR_API_KEY", shadowsStoredKey: true, agentId: "visitor_ada" },
        environment: ["ARCOPOLIS_VISITOR_API_KEY", "ARCOPOLIS_CONFIG_DIR"],
      },
      effects: { requests: 0 },
    });
    for (const char of ["a", "d", "e"]) expect(result.stdout).not.toContain(fakeKey(char));
  });

  it("with nothing configured suggests setup", async () => {
    const result = await run(["auth", "status"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(result.json).toMatchObject({ data: { read: { configured: false } }, next: [{ command: "arcopolis setup --json" }] });
  });
});

describe("auth forget", () => {
  beforeEach(async () => {
    await seed({
      default: { source: "import", readKey: { key: fakeKey("a"), origin: "https://api.arcopolis.ai", savedAt: "2026-09-01T00:00:00.000Z" } },
      other: { source: "import", readKey: { key: fakeKey("b"), origin: "https://api.arcopolis.ai", savedAt: "2026-09-01T00:00:00.000Z" } },
    });
  });

  it("never prompts without a TTY: exit 10 CONFIRMATION_REQUIRED and nothing deleted", async () => {
    const result = await run(["auth", "forget"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(result.exitCode).toBe(10);
    expect(result.json).toMatchObject({ error: { code: "CONFIRMATION_REQUIRED", humanDecision: true } });
    expect(result.stderr).not.toContain("[y/N]");
    expect((await readCredentials()).profiles.default).toBeDefined();
  });

  it("--yes deletes the profile and says the keys stay valid on the server", async () => {
    const result = await run(["auth", "forget", "--yes"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      data: { profile: "default", removed: true, keysStillValid: true, portal: "https://developers.arcologylabs.com", removedKeys: [{ kind: "read", keyPrefix: "agnts_aaaa…" }] },
      effects: { writes: ["credential_store"] },
    });
    expect((result.json?.data as { message: string }).message).toMatch(/stay valid on the server.*https:\/\/developers\.arcologylabs\.com/);
    const saved = await readCredentials();
    expect(saved.profiles.default).toBeUndefined();
    expect(saved.profiles.other).toBeDefined();
  });

  it("asks y/N in a TTY: y deletes, anything else declines", async () => {
    const declined = await runTty(["auth", "forget", "--json"], ["n"]);
    expect(declined.exitCode).toBe(10);
    expect(declined.json).toMatchObject({ error: { code: "CONFIRMATION_DECLINED" } });
    expect((await readCredentials()).profiles.default).toBeDefined();
    const accepted = await runTty(["auth", "forget", "--json", "--profile", "other"], ["y"]);
    expect(accepted.exitCode).toBe(0);
    expect(accepted.stderr).toContain("stay valid on the server");
    expect((await readCredentials()).profiles.other).toBeUndefined();
  });

  it("an unknown profile is a no-op", async () => {
    const result = await run(["auth", "forget", "--profile", "nope", "--yes"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(result.json).toMatchObject({ data: { removed: false } });
  });
});
