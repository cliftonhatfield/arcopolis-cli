import { execFileSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeFetch, fakeKey, json, run, tempDir } from "./helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
let store: string;
let project: string;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir("arcopolis-status-"));
  store = path.join(dir, "store");
  project = path.join(dir, "project");
  await mkdir(project, { recursive: true });
});
afterEach(async () => {
  await cleanup();
});

async function seed(profiles: Record<string, unknown>, mode = 0o600): Promise<void> {
  await mkdir(store, { recursive: true, mode: 0o700 });
  const file = path.join(store, "credentials.json");
  await writeFile(file, JSON.stringify({ schemaVersion: 1, profiles }));
  await chmod(file, mode);
}

function readProfile(key: string, lastVerifiedAt: string | null = "2026-09-23T00:00:00.000Z"): Record<string, unknown> {
  return {
    source: "import",
    readKey: { key, tier: 1, origin: "https://api.arcopolis.ai", savedAt: "2026-09-22T00:00:00.000Z", lastVerifiedAt },
  };
}

const neverFetch = (): ReturnType<typeof fakeFetch> => fakeFetch(() => json(500, { error: { code: "SHOULD_NOT_CALL" } }));

describe("status", () => {
  it("a live pending setup approval shows its code (never the device code or key) and next resumes it", async () => {
    await mkdir(store, { recursive: true, mode: 0o700 });
    const now = Date.now();
    const deviceCode = `agnts_dc_${"1".repeat(64)}`;
    await writeFile(
      path.join(store, "pending-grant.json"),
      JSON.stringify({
        schemaVersion: 1,
        userCode: "WDJB-MJHT",
        deviceCode,
        privateKeyJwk: { kty: "EC", crv: "P-256", x: "x".repeat(43), y: "y".repeat(43), d: "SECRETd".repeat(6).slice(0, 43) },
        expiresAt: new Date(now + 600_000).toISOString(),
        createdAt: new Date(now).toISOString(),
      }),
      { mode: 0o600 },
    );
    const fake = neverFetch();
    const result = await run(["status", "--json"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ data: { pendingGrant: { userCode: "WDJB-MJHT", expired: false } } });
    expect(result.json?.next).toEqual([expect.objectContaining({ command: "arcopolis setup --json", why: "Resume the pending setup approval (same code)" })]);
    expect(result.stdout).not.toContain(deviceCode);
    expect(result.stdout).not.toContain("SECRETd");
    expect(fake.calls).toHaveLength(0);
  });

  it("with no credentials: exit 0, zero requests, next is setup", async () => {
    const fake = neverFetch();
    const result = await run(["status", "--json"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(result.json).toMatchObject({
      ok: true,
      command: "status",
      data: { profile: "default", read: { configured: false }, visitor: { configured: false }, pendingGrant: null, pendingAction: null },
      effects: { network: [], requests: 0, writes: [], spends: {}, secretsWritten: [] },
      next: [{ command: "arcopolis setup --json", humanDecision: false }],
    });
    expect((result.json?.data as { store: string }).store).toMatch(/\(env\)$/);
  });

  it("reports a stored key redacted, with its source, tier, and verification time", async () => {
    await seed({ default: readProfile(fakeKey("a")) });
    const fake = neverFetch();
    const result = await run(["status"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project, fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(result.json).toMatchObject({
      data: {
        read: { configured: true, keyPrefix: "agnts_aaaa…", source: "store", tier: 1, lastVerifiedAt: "2026-09-23T00:00:00.000Z", formatValid: true },
      },
      next: [{ command: "arcopolis agents list --per-page 5 --json", why: "First read", humanDecision: false }],
    });
    expect(result.stdout).not.toContain(fakeKey("a"));
    expect(result.stderr).not.toContain(fakeKey("a"));
  });

  it("says when an environment key overrides the stored key (names only)", async () => {
    await seed({ default: readProfile(fakeKey("a")) });
    const result = await run(["status"], {
      env: { ARCOPOLIS_CONFIG_DIR: store, ARCOPOLIS_API_KEY: fakeKey("b") },
      cwd: project,
    });
    expect(result.json).toMatchObject({
      data: { read: { source: "env", variable: "ARCOPOLIS_API_KEY", keyPrefix: "agnts_bbbb…", shadowsStoredKey: true, tier: null } },
    });
    expect(result.stdout).not.toContain(fakeKey("b"));
  });

  it("summarizes a pending visitor action without echoing its body", async () => {
    const createdAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await writeFile(
      path.join(project, ".arcopolis-pending.json"),
      JSON.stringify({
        schemaVersion: 1,
        status: "pending",
        body: { post: { text: "secret plans for the plaza" } },
        agentId: "visitor_ada",
        baseUrl: "https://api.arcopolis.ai/v1",
        keyFingerprint: "f".repeat(64),
        idempotencyKey: "action-1",
        createdAt,
      }),
    );
    const result = await run(["status"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(result.json).toMatchObject({
      data: { pendingAction: { status: "pending", kind: "post", agentId: "visitor_ada", replayWindowOpen: true, file: ".arcopolis-pending.json" } },
    });
    expect((result.json?.next as Array<{ command: string }>)[0]?.command).toBe("arcopolis visitor pending --json");
    expect(result.stdout).not.toContain("secret plans");
  });

  it("detects the agent block, the MCP stanza, and .gitignore coverage", async () => {
    execFileSync("git", ["init", "-q"], { cwd: project, stdio: "ignore" });
    await writeFile(path.join(project, "AGENTS.md"), "# Repo\n<!-- arcopolis:start v1 (managed) -->\n## Arcopolis\n<!-- arcopolis:end -->\n");
    await writeFile(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { arcopolis: { command: "arcopolis", args: ["mcp"] } } }));
    await writeFile(path.join(project, ".gitignore"), "# arcopolis:start\n.arcopolis-*\n.arcopolis/\n# arcopolis:end\n");
    await writeFile(path.join(project, "arcopolis.json"), JSON.stringify({ schemaVersion: 1, profile: "default" }));
    const result = await run(["status"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(result.json).toMatchObject({
      data: { project: { configFile: "arcopolis.json", agentInstructions: "v1", gitignore: "ok", mcp: true } },
    });
  });

  it("points at init when the repository does not ignore the CLI files", async () => {
    execFileSync("git", ["init", "-q"], { cwd: project, stdio: "ignore" });
    const result = await run(["status"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(result.json).toMatchObject({ data: { project: { gitignore: "missing" } } });
    expect((result.json?.next as Array<{ command: string }>).map((step) => step.command)).toContain("arcopolis init --json");
  });

  it("refuses a group-readable credentials file (exit 3)", async () => {
    await seed({ default: readProfile(fakeKey("a")) }, 0o644);
    const result = await run(["status"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(result.exitCode).toBe(3);
    expect(result.json).toMatchObject({ error: { code: "INSECURE_CREDENTIAL_FILE" } });
    expect(result.stdout).not.toContain(fakeKey("a"));
  });

  it("works in demo mode with the synthetic profile", async () => {
    const result = await run(["status", "--demo"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ meta: { demo: true }, data: { read: { configured: true }, visitor: { configured: true, agentId: "visitor_ada" } } });
  });

  it("renders human text on request", async () => {
    const result = await run(["status", "--output", "human"], { env: { ARCOPOLIS_CONFIG_DIR: store }, cwd: project });
    expect(result.stdout).toMatch(/Read key\s+not configured/);
    expect(result.stdout).toContain("Next: arcopolis setup --json");
  });
});
