import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findGitRoot, loadProjectConfig, resolveStateFile, sanitizeProjectConfig, stateFileSplit } from "../src/core/project.js";
import { tempDir } from "./helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await cleanup();
});

describe("arcopolis.json is untrusted", () => {
  it("keeps only profile, visitor.agentId, and stateFile", () => {
    const { config, warnings } = sanitizeProjectConfig({
      $schema: "https://api.arcopolis.ai/cli/arcopolis.schema.json",
      schemaVersion: 1,
      profile: "default",
      visitor: { agentId: "visitor_ada", key: "x" },
      stateFile: ".arcopolis-pending.json",
      apiBase: "https://evil.example/v1",
      developerBase: "https://evil.example/_developer",
      readKey: "agnts_x",
      writePolicy: "flag",
    });
    expect(config).toEqual({ profile: "default", visitor: { agentId: "visitor_ada" }, stateFile: ".arcopolis-pending.json" });
    expect(warnings.join("\n")).toMatch(/apiBase/);
    expect(warnings.join("\n")).toMatch(/developerBase/);
    expect(warnings.join("\n")).toMatch(/readKey/);
    expect(warnings.join("\n")).toMatch(/writePolicy/);
    expect(warnings.join("\n")).toMatch(/visitor\.key/);
  });

  it("enforces stateFile restrictions", () => {
    for (const bad of ["../.arcopolis-x.json", "/tmp/.arcopolis-x.json", "state.json", ".arcopolis-x.txt", "sub/.arcopolis-x.json"]) {
      const { config, warnings } = sanitizeProjectConfig({ stateFile: bad });
      expect(config.stateFile, bad).toBeUndefined();
      expect(warnings, bad).toHaveLength(1);
    }
    expect(sanitizeProjectConfig({ stateFile: ".arcopolis-visitor-2.json" }).config.stateFile).toBe(".arcopolis-visitor-2.json");
  });

  it("rejects invalid profile and agent id values", () => {
    const { config, warnings } = sanitizeProjectConfig({ profile: "Not Valid", visitor: { agentId: "bad id with spaces" } });
    expect(config).toEqual({});
    expect(warnings).toHaveLength(2);
    expect(sanitizeProjectConfig([]).warnings).toHaveLength(1);
  });

  it("finds the file from a subdirectory up to the git root", async () => {
    await mkdir(path.join(dir, ".git"));
    await mkdir(path.join(dir, "a", "b"), { recursive: true });
    await writeFile(path.join(dir, "arcopolis.json"), JSON.stringify({ profile: "work", apiBase: "https://x" }));
    const loaded = await loadProjectConfig(path.join(dir, "a", "b"));
    expect(await findGitRoot(path.join(dir, "a"))).toBe(dir);
    expect(loaded.file).toBe(path.join(dir, "arcopolis.json"));
    expect(loaded.root).toBe(dir);
    expect(loaded.config).toEqual({ profile: "work" });
    expect(loaded.warnings).toHaveLength(1);
    // The default is the starter's: .arcopolis-pending.json in cwd, not at the project root.
    expect(resolveStateFile(loaded, path.join(dir, "a"))).toBe(path.join(dir, "a", ".arcopolis-pending.json"));
    expect(resolveStateFile(loaded, path.join(dir, "a"), "x.json")).toBe(path.join(dir, "a", "x.json"));
    const explicit = { ...loaded, config: { stateFile: ".arcopolis-ada.json" } };
    expect(resolveStateFile(explicit, path.join(dir, "a"))).toBe(path.join(dir, ".arcopolis-ada.json"));
    expect(stateFileSplit(explicit, path.join(dir, "a"))).toBeNull();
    await writeFile(path.join(dir, "a", ".arcopolis-pending.json"), "{}");
    expect(stateFileSplit(explicit, path.join(dir, "a"))).toBe(path.join(dir, "a", ".arcopolis-pending.json"));
    expect(stateFileSplit(explicit, path.join(dir, "a"), "x.json")).toBeNull();
    expect(stateFileSplit(loaded, path.join(dir, "a"))).toBeNull();
  });

  it("invalid JSON is a warning, not an error", async () => {
    await writeFile(path.join(dir, "arcopolis.json"), "{not json");
    const loaded = await loadProjectConfig(dir);
    expect(loaded.config).toEqual({});
    expect(loaded.warnings[0]).toMatch(/not valid JSON/);
  });
});
