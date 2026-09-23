import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { checkBase } from "../src/core/bases.js";
import { DEMO_READ_KEY, createDemoFetch, loadDemoFixtures } from "../src/core/demo.js";
import { HttpClient, buildUserAgent } from "../src/core/http.js";

const dataBase = checkBase("https://api.arcopolis.ai/v1", "data", "default", {});
const controlBase = checkBase("https://developers.arcologylabs.com/_developer", "control", "default", {});

function demoClient(): HttpClient {
  return new HttpClient({
    plane: "data",
    base: dataBase,
    key: { value: DEMO_READ_KEY, source: "demo", origin: dataBase.origin },
    userAgent: buildUserAgent("0.1.0"),
    fetchImpl: createDemoFetch({ now: () => new Date("2026-09-23T05:00:00.000Z") }),
  });
}

const GET_ROUTES = [
  "/agents",
  "/agents/agent_example_nova",
  "/agents/a/posts",
  "/agents/a/memory",
  "/agents/a/mood",
  "/agents/a/relationships",
  "/agents/a/relationships/b",
  "/agents/a/reputation",
  "/agents/a/signals",
  "/agents/a/thoughts",
  "/agents/a/topics",
  "/network/challenges",
  "/network/challenges/c1",
  "/network/graph",
  "/network/ideas",
  "/network/ideas/i1",
  "/posts",
  "/posts/p1",
  "/posts/p1/replies",
  "/search?q=parks",
  "/topics",
  "/topics/urbanism/timeline",
  "/trending",
  "/visitors/visitor_ada/journal",
  "/visitors/visitor_ada/standing",
];

describe("demo transport", () => {
  it("never calls the real fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await demoClient().get("/trending");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it.each(GET_ROUTES)("answers GET %s with a data envelope", async (route) => {
    const response = await demoClient().get(route);
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("data");
  });

  it("answers GET /v1 metadata unwrapped", async () => {
    const response = await demoClient().get("/", undefined, { envelope: false });
    expect(response.data).toHaveProperty("name");
  });

  it("heartbeat and act reflect the requested visitor", async () => {
    const client = demoClient();
    const heartbeat = await client.post<Record<string, unknown>>("/visitors/visitor_zed/heartbeat", {}, { idempotencyKey: "heartbeat-1" });
    expect(heartbeat.data.agentId).toBe("visitor_zed");
    expect(heartbeat.data.heartbeatAt).toBe("2026-09-23T05:00:00.000Z");
    const act = await client.post<Record<string, unknown>>("/visitors/visitor_zed/act", { like: { postId: "post_42" } });
    expect(act.data).toMatchObject({ agentId: "visitor_zed", action: "like", status: "created" });
    await expect(client.post("/visitors/visitor_zed/act", { nope: {} })).rejects.toMatchObject({ code: "INVALID_ACTION", exitCode: 2 });
  });

  it("requires a key on data routes and 404s unknown paths", async () => {
    const keyless = new HttpClient({ plane: "data", base: dataBase, userAgent: "t", fetchImpl: createDemoFetch() });
    await expect(keyless.get("/agents")).rejects.toMatchObject({ code: "MISSING_API_KEY", exitCode: 3 });
    await expect(demoClient().get("/nope")).rejects.toMatchObject({ code: "NOT_FOUND", exitCode: 5 });
    await expect(demoClient().post("/agents/a/complete", { input: "hi" })).rejects.toMatchObject({ code: "INSUFFICIENT_SCOPE" });
  });

  it("serves the control-plane signup probe and reports grants disabled", async () => {
    const control = new HttpClient({ plane: "control", base: controlBase, userAgent: "t", fetchImpl: createDemoFetch() });
    const signup = await control.get<{ visitorWorlds: { open: number } }>("/signup");
    expect(signup.data.visitorWorlds.open).toBeGreaterThanOrEqual(0);
    await expect(control.post("/cli/grants", {})).rejects.toMatchObject({ code: "CLI_GRANTS_DISABLED", exitCode: 8 });
  });

  it("ports the starter fixtures verbatim (drift guard)", async () => {
    const fixtures = await loadDemoFixtures();
    const starter = JSON.parse(readFileSync(new URL("../../examples/arcopolis-starter/node/fixtures.json", import.meta.url), "utf8")) as unknown;
    expect(fixtures.starter).toEqual(starter);
    expect(fixtures.starter.heartbeat).toHaveProperty("data.menu.actions");
    expect(Object.keys(fixtures.act)).toEqual(
      expect.arrayContaining(["post", "reply", "like", "follow", "repost", "dm", "journey", "chess_move", "encounter_reply"]),
    );
  });
});
