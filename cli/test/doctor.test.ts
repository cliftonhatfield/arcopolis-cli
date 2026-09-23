import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeFetch, fakeKey, json, run, tempDir } from "./helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
let store: string;
let project: string;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir("arcopolis-doctor-"));
  store = path.join(dir, "store");
  project = path.join(dir, "project");
  await mkdir(project, { recursive: true });
});
afterEach(async () => {
  await cleanup();
});

async function seed(lastVerifiedAt: string | null, mode = 0o600): Promise<void> {
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
  await chmod(file, mode);
}

interface Check {
  id: string;
  status: string;
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

function checks(result: { json: Record<string, unknown> | null }): Check[] {
  return (result.json?.data as { checks: Check[] }).checks;
}

function check(result: { json: Record<string, unknown> | null }, id: string): Check | undefined {
  return checks(result).find((entry) => entry.id === id);
}

/** Answers signup and GET /v1; anything else is a failure the test would notice. */
function planes(): ReturnType<typeof fakeFetch> {
  return fakeFetch((url) => {
    if (url === "https://developers.arcologylabs.com/_developer/signup") {
      return json(200, { data: { open: true, termsVersion: "2026-09-16", visitorWorlds: { open: 2 } } });
    }
    if (url === "https://api.arcopolis.ai/v1") return json(200, { name: "AGNTS Public API", version: "1.0.0" });
    return json(404, { error: { code: "NOT_FOUND", message: "unexpected" } });
  });
}

describe("doctor (offline)", () => {
  it("makes zero requests and says so", async () => {
    await seed(new Date().toISOString());
    const fake = planes();
    const result = await run(["doctor"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(result.json).toMatchObject({
      data: { online: false, requests: 0, spentDailyBudget: false, message: "Doctor made 0 requests and spent no daily budget." },
      effects: { network: [], requests: 0, spends: {} },
    });
    expect(check(result, "node")?.status).toBe("ok");
    expect(check(result, "store_permissions")?.status).toBe("ok");
    expect(check(result, "keys")?.status).toBe("ok");
    expect(check(result, "data_base")?.status).toBe("ok");
    expect(result.stdout).not.toContain(fakeKey("a"));
  });

  it("human output ends with the request and budget line", async () => {
    const result = await run(["doctor", "--output", "human"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("Doctor made 0 requests and spent no daily budget.");
  });

  it("reports loose modes and --fix-permissions repairs them", async () => {
    await seed(null, 0o644);
    await chmod(store, 0o755);
    const before = await run(["doctor"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(before.exitCode).toBe(0);
    expect(before.json).toMatchObject({ data: { healthy: false } });
    expect(check(before, "store_permissions")).toMatchObject({ status: "fail", code: "INSECURE_CREDENTIAL_FILE" });
    expect(check(before, "credentials_file")).toMatchObject({ status: "fail", code: "INSECURE_CREDENTIAL_FILE" });
    expect((before.json?.next as Array<{ command: string }>)[0]?.command).toBe("arcopolis doctor --fix-permissions");

    const fixed = await run(["doctor", "--fix-permissions"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(check(fixed, "store_permissions")).toMatchObject({ status: "ok" });
    expect(check(fixed, "credentials_file")?.status).toBe("ok");
    expect(fixed.json).toMatchObject({ effects: { writes: ["credential_store"], requests: 0 } });
    expect((await stat(path.join(store, "credentials.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(store)).mode & 0o777).toBe(0o700);
  });

  it("finds a key committed to git and reports file names only", async () => {
    execFileSync("git", ["init", "-q"], { cwd: project, stdio: "ignore" });
    await writeFile(path.join(project, "config.js"), `export const key = "${fakeKey("e")}";\n`);
    execFileSync("git", ["add", "config.js"], { cwd: project, stdio: "ignore" });
    const result = await run(["doctor"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(check(result, "committed_keys")).toMatchObject({ status: "fail", code: "KEY_IN_TRACKED_FILE", details: { files: ["config.js"] } });
    expect(result.stdout).not.toContain(fakeKey("e"));
    expect(check(result, "gitignore")).toMatchObject({ status: "warn" });
    expect((result.json?.next as Array<{ command: string; humanDecision: boolean }>)).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "arcopolis portal", humanDecision: true })]),
    );
  });

  it("checks .gitignore coverage including managed env files", async () => {
    execFileSync("git", ["init", "-q"], { cwd: project, stdio: "ignore" });
    await writeFile(path.join(project, ".gitignore"), "# arcopolis:start\n.arcopolis-*\n.arcopolis/\n.env.arcopolis\n# arcopolis:end\n");
    const result = await run(["doctor"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(check(result, "gitignore")).toMatchObject({ status: "ok" });
    expect(check(result, "gitignore")?.message).toContain(".env.arcopolis");
    expect(check(result, "committed_keys")?.status).toBe("ok");
  });

  it("flags a pending action outside the 24 hour window", async () => {
    await writeFile(
      path.join(project, ".arcopolis-pending.json"),
      JSON.stringify({ schemaVersion: 1, status: "pending", body: { like: { postId: "p1" } }, agentId: "a", createdAt: "2026-01-01T00:00:00.000Z", idempotencyKey: "action-x" }),
    );
    const result = await run(["doctor"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(check(result, "pending_action")).toMatchObject({ status: "fail", code: "PENDING_TOO_OLD" });
  });

  it("warns about an agent block older than the current one, and a live pending setup approval is info", async () => {
    await writeFile(path.join(project, "AGENTS.md"), "<!-- arcopolis:start v1 (managed) -->\n## Arcopolis\n<!-- arcopolis:end -->\n");
    await mkdir(store, { recursive: true, mode: 0o700 });
    const now = Date.now();
    await writeFile(
      path.join(store, "pending-grant.json"),
      JSON.stringify({ schemaVersion: 1, userCode: "WDJB-MJHT", expiresAt: new Date(now + 600_000).toISOString(), createdAt: new Date(now).toISOString() }),
      { mode: 0o600 },
    );
    const result = await run(["doctor", "--json"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(check(result, "agent_instructions")).toMatchObject({ status: "warn", message: expect.stringContaining("v1 in AGENTS.md") });
    expect(check(result, "pending_grant")).toMatchObject({ status: "info", message: expect.stringContaining("WDJB-MJHT") });
  });

  it("names environment overrides without values", async () => {
    await seed(null);
    const result = await run(["doctor"], { env: { ARCOPOLIS_CONFIG_DIR: store, ARCOPOLIS_API_KEY: fakeKey("b"), AGNTS_API_BASE_URL: "https://api.arcopolis.ai/v1" }, cwd: project });
    expect(check(result, "keys")?.message).toContain("overrides the stored key");
    expect(check(result, "environment")).toMatchObject({ status: "warn", code: "DEPRECATED_ENV" });
    expect(result.stdout).not.toContain(fakeKey("b"));
  });

  it("--verify without --online is a usage error", async () => {
    const result = await run(["doctor", "--verify"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(result.exitCode).toBe(2);
    expect(result.json).toMatchObject({ error: { code: "USAGE_ERROR" } });
  });

  it("works in demo mode", async () => {
    const result = await run(["doctor", "--demo"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ meta: { demo: true }, data: { requests: 0 } });
  });
});

describe("doctor --online", () => {
  it("probes signup only when the stored key was verified in the last 24 hours", async () => {
    await seed(new Date(Date.now() - 3_600_000).toISOString());
    const fake = planes();
    const result = await run(["doctor", "--online"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: fake.fetchImpl });
    expect(fake.calls.map((call) => call.url)).toEqual(["https://developers.arcologylabs.com/_developer/signup"]);
    expect(fake.calls[0]?.headers["x-api-key"]).toBeUndefined();
    expect(check(result, "control_plane")).toMatchObject({ status: "ok", details: { visitorWorldsOpen: 2 } });
    expect(check(result, "verify_read_key")?.status).toBe("ok");
    expect(result.json).toMatchObject({ data: { requests: 1, message: "Doctor made 1 request and spent no daily budget." } });
  });

  it("verifies a stale stored key once and records the time", async () => {
    await seed("2026-01-01T00:00:00.000Z");
    const fake = planes();
    const result = await run(["doctor", "--online"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: fake.fetchImpl });
    expect(fake.calls.map((call) => call.url)).toEqual([
      "https://developers.arcologylabs.com/_developer/signup",
      "https://api.arcopolis.ai/v1",
    ]);
    expect(check(result, "verify_read_key")).toMatchObject({ status: "ok" });
    expect(result.json).toMatchObject({ data: { requests: 2 }, effects: { requests: 2, spends: { rateLimit: 1 } } });
    const saved = JSON.parse(await readFile(path.join(store, "credentials.json"), "utf8")) as {
      profiles: { default: { readKey: { lastVerifiedAt: string } } };
    };
    expect(saved.profiles.default.readKey.lastVerifiedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });

  it("--verify re-checks a fresh key; failures are checks, not exit codes", async () => {
    await seed(new Date().toISOString());
    const fake = fakeFetch((url) =>
      url.endsWith("/signup")
        ? json(503, { error: { code: "DEVELOPER_PORTAL_DISABLED", message: "off" } })
        : json(401, { error: { code: "KEY_REVOKED", message: "revoked" } }),
    );
    const result = await run(["doctor", "--online", "--verify"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(fake.calls).toHaveLength(2);
    expect(check(result, "control_plane")).toMatchObject({ status: "fail", code: "DEVELOPER_PORTAL_DISABLED" });
    expect(check(result, "verify_read_key")).toMatchObject({ status: "fail", code: "KEY_REVOKED" });
    expect(result.json).toMatchObject({ data: { healthy: false } });
  });

  it("never verifies environment keys and never calls visitor routes", async () => {
    const fake = planes();
    const result = await run(["doctor", "--online", "--verify"], {
      env: { ARCOPOLIS_CONFIG_DIR: store, ARCOPOLIS_VISITOR_API_KEY: fakeKey("d"), ARCOPOLIS_VISITOR_AGENT_ID: "visitor_ada" },
      cwd: project,
      fetchImpl: fake.fetchImpl,
    });
    expect(fake.calls.map((call) => call.url)).toEqual(["https://developers.arcologylabs.com/_developer/signup"]);
    expect(check(result, "verify_visitor_key")?.status).toBe("skip");
    expect(fake.calls.some((call) => /visitors|heartbeat|journal|standing|usage/.test(call.url))).toBe(false);
  });
});
