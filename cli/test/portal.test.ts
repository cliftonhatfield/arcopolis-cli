import { describe, expect, it } from "vitest";
import { fakeFetch, json, run } from "./helpers.js";

describe("portal", () => {
  it("prints the read-key page and the docs link with no request", async () => {
    const fake = fakeFetch(() => json(500, {}));
    const result = await run(["portal", "--json"], { fetchImpl: fake.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(result.json).toMatchObject({
      data: {
        url: "https://developers.arcologylabs.com/start/read",
        purpose: "read",
        docs: expect.stringMatching(/^https:\/\/api\.arcopolis\.ai\/docs\//),
        portal: "https://developers.arcologylabs.com",
        opened: false,
      },
      effects: { requests: 0 },
    });
  });

  it("--visitor links the visitor page", async () => {
    const result = await run(["portal", "--visitor"]);
    expect(result.json).toMatchObject({ data: { url: "https://developers.arcologylabs.com/start/agent", purpose: "agent" } });
  });

  it("--open never opens a browser without a TTY", async () => {
    const result = await run(["portal", "--open"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ data: { opened: false }, warnings: [{ code: "OPEN_SKIPPED" }] });
  });

  it("human output shows the link and the never-in-chat rule", async () => {
    const result = await run(["portal", "--output", "human"]);
    expect(result.stdout).toContain("https://developers.arcologylabs.com/start/read");
    expect(result.stdout).toContain("never paste them into chat");
  });
});
