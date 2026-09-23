import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliRuntime } from "../src/cli/main.js";
import { defaultAppName, slugify } from "../src/cli/commands/setup.js";
import { AGENTS_BLOCK } from "../src/init/templates.js";
import { Capture, fakeFetch, fakeKey, json, run, tempDir, type RunResult } from "./helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
let store: string;
let project: string;

const SIGNUP_URL = "https://developers.arcologylabs.com/_developer/signup";
/** R1: these fakes answer 404 there, as a backend without the grant routes does, so setup falls back to the guided flow. */
const GRANTS_URL = "https://developers.arcologylabs.com/_developer/cli/grants";
const V1_URL = "https://api.arcopolis.ai/v1";

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir("arcopolis-setup-"));
  store = path.join(dir, "store");
  project = path.join(dir, "my-project");
  await mkdir(project, { recursive: true });
});
afterEach(async () => {
  await cleanup();
});

function planes(worldsOpen = 1): ReturnType<typeof fakeFetch> {
  return fakeFetch((url) => {
    if (url === SIGNUP_URL) return json(200, { data: { open: worldsOpen > 0, termsVersion: "2026-09-16", visitorWorlds: { open: worldsOpen } } });
    if (url === V1_URL) return json(200, { name: "AGNTS Public API", version: "1.0.0" });
    return json(404, { error: { code: "NOT_FOUND", message: "unexpected" } });
  });
}

async function seed(lastVerifiedAt: string | null): Promise<void> {
  await mkdir(store, { recursive: true, mode: 0o700 });
  const file = path.join(store, "credentials.json");
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      profiles: {
        default: {
          source: "import",
          readKey: { key: fakeKey("a"), tier: 1, origin: "https://api.arcopolis.ai", savedAt: "2026-09-01T00:00:00.000Z", lastVerifiedAt },
        },
      },
    }),
  );
  await chmod(file, 0o600);
}

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
  return { exitCode, stdout: stdout.text, stderr: stderr.text, json: line ? (JSON.parse(line) as Record<string, unknown>) : null };
}

describe("setup (non-interactive guided fallback)", () => {
  it("exits 10 HUMAN_SETUP_REQUIRED with humanAction after the signup probe and a refused grant start, without prompting", async () => {
    const fake = planes();
    const started = Date.now();
    const result = await run(["setup", "--json"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: fake.fetchImpl });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.exitCode).toBe(10);
    expect(fake.calls.map((call) => call.url)).toEqual([SIGNUP_URL, GRANTS_URL]);
    expect(fake.calls.every((call) => call.headers["x-api-key"] === undefined)).toBe(true);
    expect(result.json).toMatchObject({
      schemaVersion: 1,
      ok: false,
      command: "setup",
      exitCode: 10,
      error: {
        category: "needs_human",
        code: "HUMAN_SETUP_REQUIRED",
        surface: "local",
        retry: { strategy: "after_human" },
        humanDecision: true,
        hint: expect.stringContaining("Never ask for a key in chat"),
      },
      humanAction: {
        mode: "guided",
        portalUrl: "https://developers.arcologylabs.com/start/read",
        requested: { app: "my-project", readKey: { tier: 1 }, visitor: null },
        environment: [{ name: "ARCOPOLIS_API_KEY", secret: true }],
        termsTheHumanWillSee: [{ name: "Developer/API Terms", version: "2026-07-20" }],
      },
      effects: { network: ["control"], requests: 2, writes: [], spends: {}, secretsWritten: [] },
      next: [{ command: "arcopolis status --json", humanDecision: false }],
    });
    const action = result.json?.humanAction as { tellTheHuman: string; steps: string[] };
    expect(action.tellTheHuman).toContain("https://developers.arcologylabs.com/start/read");
    expect(action.tellTheHuman).toContain("ARCOPOLIS_API_KEY");
    expect(action.tellTheHuman).toContain("never paste a key into chat");
    expect(action.steps.join(" ")).toContain("arcopolis auth import");
    expect(result.stderr).not.toContain("hidden");
    await expect(stat(path.join(store, "credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("--visitor adds the visitor page, variables, and corpus terms", async () => {
    const result = await run(["setup", "--visitor", "--world", "world_7"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: planes().fetchImpl });
    expect(result.exitCode).toBe(10);
    expect(result.json).toMatchObject({
      humanAction: {
        links: { read: "https://developers.arcologylabs.com/start/read", agent: "https://developers.arcologylabs.com/start/agent" },
        requested: { visitor: { world: "world_7", slug: "my-project" } },
        environment: [{ name: "ARCOPOLIS_API_KEY" }, { name: "ARCOPOLIS_VISITOR_API_KEY", secret: true }, { name: "ARCOPOLIS_VISITOR_AGENT_ID", secret: false }],
        termsTheHumanWillSee: [{ version: "2026-07-20" }, { version: "2026-09-16" }],
      },
    });
    expect((result.json?.humanAction as { tellTheHuman: string }).tellTheHuman).toContain("ARCOPOLIS_VISITOR_AGENT_ID");
  });

  it("a visitor-only request with no open world exits 8 NO_VISITOR_WORLD_OPEN", async () => {
    const result = await run(["setup", "--no-read", "--visitor"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: planes(0).fetchImpl });
    expect(result.exitCode).toBe(8);
    expect(result.json).toMatchObject({ error: { code: "NO_VISITOR_WORLD_OPEN", category: "unavailable" } });
  });

  it("with no open world a read + visitor request drops the visitor and warns", async () => {
    const result = await run(["setup", "--visitor"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: planes(0).fetchImpl });
    expect(result.exitCode).toBe(10);
    expect(result.json).toMatchObject({
      humanAction: { requested: { visitor: null } },
      warnings: expect.arrayContaining([expect.objectContaining({ code: "VISITOR_DROPPED" })]),
    });
  });

  it("a disabled portal exits 8", async () => {
    const fake = fakeFetch(() => json(503, { error: { code: "DEVELOPER_PORTAL_DISABLED", message: "The developer portal is disabled." } }));
    const result = await run(["setup"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(8);
    expect(result.json).toMatchObject({ error: { code: "DEVELOPER_PORTAL_DISABLED", surface: "control" } });
  });

  it("an unreachable portal only warns; no approval is tried and the human steps still come back", async () => {
    const fake = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    const result = await run(["setup"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(10);
    expect(result.json).toMatchObject({ error: { code: "HUMAN_SETUP_REQUIRED" }, warnings: [{ code: "SIGNUP_PROBE_FAILED" }] });
    expect(fake.calls.map((call) => call.url)).toEqual([SIGNUP_URL]);
  });

  it("--resume with no pending approval is exit 5 GRANT_NOT_STARTED (no request)", async () => {
    const fake = planes();
    const result = await run(["setup", "--resume"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(5);
    expect(result.json).toMatchObject({ error: { code: "GRANT_NOT_STARTED" } });
    expect(fake.calls).toHaveLength(0);
  });

  it("--store project without ARCOPOLIS_CONFIG_DIR=.arcopolis is a usage error", async () => {
    const result = await run(["setup", "--store", "project"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(result.exitCode).toBe(2);
  });

  it("grant-only flags are reported as ignored when the guided setup takes over", async () => {
    const result = await run(["setup", "--label", "laptop", "--no-browser"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: planes().fetchImpl });
    expect(result.json).toMatchObject({
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: "CLI_GRANTS_UNAVAILABLE" }),
        expect.objectContaining({ code: "GRANT_FLAGS_IGNORED" }),
      ]),
    });
  });

  it("a malformed --expect-email or --slug is exit 2 before any request", async () => {
    const fake = planes();
    for (const argv of [["setup", "--expect-email", "not-an-email"], ["setup", "--visitor", "--slug", "Bad_Slug"], ["setup", "--label", "x", "--no-label"]]) {
      const result = await run(argv, { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: fake.fetchImpl });
      expect(result.exitCode, argv.join(" ")).toBe(2);
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe("setup preflight", () => {
  it("a recently verified stored key exits 0 with no request", async () => {
    await seed(new Date(Date.now() - 3_600_000).toISOString());
    const fake = planes();
    const result = await run(["setup"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(result.json).toMatchObject({
      data: { profile: "default", mode: "existing", approvedBy: null, readKey: { keyPrefix: "agnts_aaaa…", action: "existing", verified: true }, visitor: null, files: [] },
      effects: { requests: 0 },
      next: [{ command: "arcopolis agents list --per-page 5 --json" }, { command: "arcopolis exec -- node app.mjs" }],
    });
    expect(result.stdout).not.toContain(fakeKey("a"));
  });

  it("an environment key counts as configured (no request)", async () => {
    const fake = planes();
    const result = await run(["setup"], { env: { ARCOPOLIS_CONFIG_DIR: store, ARCOPOLIS_API_KEY: fakeKey("b") }, cwd: project, fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(result.json).toMatchObject({ data: { readKey: { source: "env", variable: "ARCOPOLIS_API_KEY", verified: null } } });
  });

  it("a stale stored key is verified once and kept", async () => {
    await seed("2026-01-01T00:00:00.000Z");
    const fake = planes();
    const result = await run(["setup"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(fake.calls.map((call) => call.url)).toEqual([V1_URL]);
    expect(result.json).toMatchObject({ data: { mode: "existing", readKey: { verified: true } } });
    const saved = JSON.parse(await readFile(path.join(store, "credentials.json"), "utf8")) as {
      profiles: { default: { readKey: { lastVerifiedAt: string } } };
    };
    expect(saved.profiles.default.readKey.lastVerifiedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });

  it("a stale stored key the API rejects falls through to the guided fallback", async () => {
    await seed("2026-01-01T00:00:00.000Z");
    const fake = fakeFetch((url) =>
      url === V1_URL
        ? json(401, { error: { code: "KEY_REVOKED", message: "revoked" } })
        : url === SIGNUP_URL
          ? json(200, { data: { open: true, termsVersion: "2026-09-16", visitorWorlds: { open: 1 } } })
          : json(503, { error: { code: "CLI_GRANTS_DISABLED", message: "off" } }),
    );
    const result = await run(["setup"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(10);
    expect(fake.calls.map((call) => call.url)).toEqual([V1_URL, SIGNUP_URL, GRANTS_URL]);
    expect(result.json).toMatchObject({
      error: { code: "HUMAN_SETUP_REQUIRED" },
      warnings: expect.arrayContaining([expect.objectContaining({ code: "STORED_KEY_REJECTED" })]),
    });
  });

  it("--force skips the early exit", async () => {
    await seed(new Date().toISOString());
    const result = await run(["setup", "--force"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: planes().fetchImpl });
    expect(result.exitCode).toBe(10);
  });

  it("demo mode: the synthetic profile is already set up; --force shows the human steps", async () => {
    const existing = await run(["setup", "--demo"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(existing.exitCode).toBe(0);
    expect(existing.json).toMatchObject({ meta: { demo: true }, data: { mode: "existing" } });
    const forced = await run(["setup", "--demo", "--force"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(forced.exitCode).toBe(10);
    expect(forced.json).toMatchObject({ error: { code: "HUMAN_SETUP_REQUIRED" } });
    await expect(stat(store)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("setup (TTY guided import)", () => {
  it("prints the portal link, reads the key from a hidden prompt, stores it at 0600, and verifies it", async () => {
    const fake = planes();
    const result = await runTty(["setup", "--json"], [fakeKey("c")], { fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("https://developers.arcologylabs.com/start/read");
    expect(result.stderr).toContain("Developer/API Terms (2026-07-20)");
    expect(result.stderr).not.toContain(fakeKey("c"));
    expect(fake.calls.map((call) => call.url)).toEqual([SIGNUP_URL, GRANTS_URL, V1_URL]);
    expect(result.json).toMatchObject({
      data: { mode: "guided_import", readKey: { keyPrefix: "agnts_cccc…", action: "imported", verified: true }, visitor: null },
      effects: { writes: ["credential_store"], secretsWritten: ["credential_store:readKey"] },
    });
    expect((await stat(path.join(store, "credentials.json"))).mode & 0o777).toBe(0o600);
  });

  it("imports a visitor (agent id and drive key) and writes an env file on request", async () => {
    const fake = planes();
    const result = await runTty(["setup", "--no-read", "--visitor", "--world", "world_7", "--write-env-file", ".env.arcopolis", "--json"], ["visitor_ada", fakeKey("d")], {
      fetchImpl: fake.fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("https://developers.arcologylabs.com/start/agent");
    expect(result.json).toMatchObject({
      data: { readKey: null, visitor: { agentId: "visitor_ada", action: "imported", verified: true }, files: [".env.arcopolis"] },
    });
    const saved = JSON.parse(await readFile(path.join(store, "credentials.json"), "utf8")) as {
      profiles: { default: { visitor: Record<string, unknown> } };
    };
    expect(saved.profiles.default.visitor).toMatchObject({ agentId: "visitor_ada", worldId: "world_7", key: fakeKey("d") });
    const envFile = await readFile(path.join(project, ".env.arcopolis"), "utf8");
    expect(envFile).toContain("ARCOPOLIS_VISITOR_AGENT_ID=visitor_ada");
    expect((await stat(path.join(project, ".env.arcopolis"))).mode & 0o777).toBe(0o600);
  });

  it("a stale read key verified in preflight does not stop the visitor import that follows from being verified", async () => {
    await seed("2026-01-01T00:00:00.000Z");
    const fake = planes();
    const result = await runTty(["setup", "--visitor", "--json"], ["visitor_ada", fakeKey("d")], { fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      data: {
        readKey: { action: "existing", verified: true },
        visitor: { action: "imported", agentId: "visitor_ada", verified: true, verification: { verified: true } },
      },
    });
    expect((result.json as { warnings: Array<{ code: string }> }).warnings.map((w) => w.code)).not.toContain("KEY_NOT_VERIFIED");
    expect(result.stdout).not.toContain(fakeKey("d"));
  });

  it("--write-env-file never pairs a stored key with a base on another origin, and refuses before any prompt", async () => {
    await seed(new Date().toISOString());
    const fake = planes();
    const result = await runTty(["setup", "--visitor", "--write-env-file", ".env.arc", "--json"], ["visitor_ada", fakeKey("d")], {
      env: { ARCOPOLIS_CONFIG_DIR: store, ARCOPOLIS_API_BASE: "http://127.0.0.1:18768/v1" },
      fetchImpl: fake.fetchImpl,
    });
    expect(result.exitCode).toBe(3);
    expect(result.json).toMatchObject({ error: { code: "STORED_KEY_ORIGIN_MISMATCH" } });
    expect(result.stderr).not.toContain("(input is hidden)");
    await expect(stat(path.join(project, ".env.arc"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.stdout).not.toContain(fakeKey("a"));
  });

  it("a malformed pasted key exits 2 and stores nothing", async () => {
    const result = await runTty(["setup", "--json"], ["agnts_short"], { fetchImpl: planes().fetchImpl });
    expect(result.exitCode).toBe(2);
    expect(result.json).toMatchObject({ error: { code: "INVALID_KEY_FORMAT" } });
    await expect(stat(path.join(store, "credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("setup and the installed agent block agree", () => {
  it("every humanAction field and next step the block names exists in the exit-10 document it names it for", async () => {
    const named = [...AGENTS_BLOCK.matchAll(/humanAction\.([A-Za-z]+)/g)].map((match) => match[1] as string);
    expect(named).toEqual(expect.arrayContaining(["tellTheHuman", "verificationUriComplete", "userCode"]));
    // The grant path (APPROVAL_PENDING) carries every named field.
    const grant = fakeFetch((url) => {
      if (url === SIGNUP_URL) return json(200, { data: { open: true, termsVersion: "2026-09-16", visitorWorlds: { open: 1 } } });
      if (url === GRANTS_URL) {
        return json(201, {
          data: {
            userCode: "WDJB-MJHT",
            deviceCode: `agnts_dc_${"1".repeat(64)}`,
            verificationUri: "https://developers.arcologylabs.com/cli",
            verificationUriComplete: "https://developers.arcologylabs.com/cli#code=WDJB-MJHT",
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            expiresIn: 600,
            interval: 5,
          },
        });
      }
      return json(404, { error: { code: "NOT_FOUND", message: "unexpected" } });
    });
    const pending = await run(["setup", "--json"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: grant.fetchImpl });
    expect(pending.json).toMatchObject({ error: { code: "APPROVAL_PENDING" } });
    const grantAction = pending.json?.humanAction as Record<string, unknown>;
    for (const field of named) expect(typeof grantAction[field], `humanAction.${field}`).toBe("string");
    expect((pending.json?.next as unknown[]).length).toBeGreaterThan(0);
    // The guided fallback (HUMAN_SETUP_REQUIRED) carries tellTheHuman and next[].
    for (const argv of [["setup", "--new", "--json"], ["setup", "--new", "--visitor", "--json"]]) {
      const result = await run(argv, { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: planes().fetchImpl });
      expect(result.exitCode).toBe(10);
      expect(result.json).toMatchObject({ error: { code: "HUMAN_SETUP_REQUIRED" } });
      expect(typeof (result.json?.humanAction as Record<string, unknown>).tellTheHuman).toBe("string");
      expect((result.json?.next as unknown[]).length).toBeGreaterThan(0);
    }
    for (const code of ["APPROVAL_PENDING", "APPROVAL_DENIED", "CLI_GRANT_EXPIRED", "HUMAN_SETUP_REQUIRED"]) expect(AGENTS_BLOCK).toContain(code);
    expect(AGENTS_BLOCK).toContain("arcopolis setup --new --json");
    expect(AGENTS_BLOCK).toContain("arcopolis_setup_start");
    await seed(new Date().toISOString());
    const done = await run(["setup", "--json"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: planes().fetchImpl });
    expect(done.json?.data).toHaveProperty("approvedBy");
  });
});

describe("setup helpers", () => {
  it("default app name and slug", () => {
    expect(defaultAppName("/work/My Project!")).toBe("My Project");
    expect(defaultAppName("/")).toBe("my-app");
    expect(slugify("My Project 2")).toBe("my-project-2");
    expect(slugify("!!!")).toBe("visitor");
  });
});
