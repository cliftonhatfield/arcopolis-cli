import { describe, expect, it } from "vitest";
import { canOpenBrowser, openInBrowser } from "../src/cli/commands/portal.js";
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

describe("opening a browser", () => {
  it("only where a browser would be in front of the person", () => {
    expect(canOpenBrowser("darwin", {})).toBe(true);
    expect(canOpenBrowser("win32", {})).toBe(true);
    expect(canOpenBrowser("darwin", { SSH_CONNECTION: "10.0.0.2 51234 10.0.0.1 22" })).toBe(false);
    expect(canOpenBrowser("linux", { SSH_TTY: "/dev/pts/0", DISPLAY: ":0" })).toBe(false);
    expect(canOpenBrowser("linux", {})).toBe(false);
    expect(canOpenBrowser("linux", { DISPLAY: ":0" })).toBe(true);
    expect(canOpenBrowser("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
    expect(canOpenBrowser("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toBe(true);
  });

  it("reports false over SSH without starting an opener", async () => {
    await expect(openInBrowser("https://example.test/", "darwin", { SSH_TTY: "/dev/ttys001" })).resolves.toBe(false);
    await expect(openInBrowser("https://example.test/", "linux", {})).resolves.toBe(false);
  });
});
