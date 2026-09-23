import { execFileSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { managedEnvNames, upsertEnvBlock, writeEnvFile } from "../src/core/envFile.js";
import { ensureGitignore, upsertManagedBlock } from "../src/core/gitignore.js";
import { fakeKey, tempDir } from "./helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await cleanup();
});

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

const vars = {
  ARCOPOLIS_API_BASE: "https://api.arcopolis.ai/v1",
  ARCOPOLIS_API_KEY: fakeKey("7"),
};

describe("managed blocks", () => {
  it("upsert is idempotent and preserves text outside the markers", () => {
    const original = "node_modules/\n# mine\n";
    const first = upsertManagedBlock(original, [".arcopolis-*", ".arcopolis/"]);
    expect(first.changed).toBe(true);
    expect(first.content).toBe("node_modules/\n# mine\n# arcopolis:start\n.arcopolis-*\n.arcopolis/\n# arcopolis:end\n");
    const second = upsertManagedBlock(first.content, [".arcopolis-*", ".arcopolis/"]);
    expect(second.changed).toBe(false);
    const replaced = upsertManagedBlock(`${first.content}after\n`, [".arcopolis-*"]);
    expect(replaced.content).toBe("node_modules/\n# mine\n# arcopolis:start\n.arcopolis-*\n# arcopolis:end\nafter\n");
  });

  it("env block is idempotent and lists names only", () => {
    const once = upsertEnvBlock("OTHER=1\n", vars);
    expect(upsertEnvBlock(once.content, vars).changed).toBe(false);
    expect(once.content.startsWith("OTHER=1\n# arcopolis:start\n")).toBe(true);
    expect(managedEnvNames(once.content)).toEqual(["ARCOPOLIS_API_BASE", "ARCOPOLIS_API_KEY"]);
  });

  it("ensureGitignore is idempotent and keeps extra entries", async () => {
    const created = await ensureGitignore(dir, [".env.arcopolis"]);
    expect(created.action).toBe("created");
    expect(created.added).toEqual([".arcopolis-*", ".arcopolis/", ".env.arcopolis"]);
    const again = await ensureGitignore(dir);
    expect(again.action).toBe("unchanged");
    expect(await readFile(path.join(dir, ".gitignore"), "utf8")).toContain(".env.arcopolis");
  });
});

describe("writeEnvFile", () => {
  it("refuses a tracked file", async () => {
    git("init", "-q");
    await writeFile(path.join(dir, ".env"), "X=1\n");
    git("add", ".env");
    await expect(
      writeEnvFile({ root: dir, file: ".env", vars, confirmGitignore: async () => true }),
    ).rejects.toMatchObject({ code: "ENV_FILE_TRACKED", exitCode: 2 });
    expect(await readFile(path.join(dir, ".env"), "utf8")).toBe("X=1\n");
  });

  it("asks before adding an unignored file to .gitignore, then writes 0600 and redacts previews", async () => {
    git("init", "-q");
    const asked: string[] = [];
    await expect(
      writeEnvFile({ root: dir, file: ".env.local", vars, confirmGitignore: async () => false }),
    ).rejects.toMatchObject({ code: "ENV_FILE_NOT_IGNORED" });
    const result = await writeEnvFile({
      root: dir,
      file: ".env.local",
      vars,
      confirmGitignore: async (relative) => {
        asked.push(relative);
        return true;
      },
    });
    expect(asked).toEqual([".env.local"]);
    expect(result.action).toBe("created");
    expect(result.gitignore?.added).toContain(".env.local");
    expect(JSON.stringify(result.variables)).not.toContain(fakeKey("7"));
    expect(result.variables.find((entry) => entry.name === "ARCOPOLIS_API_KEY")?.preview).toBe("agnts_7777…");
    if (process.platform !== "win32") expect((await stat(path.join(dir, ".env.local"))).mode & 0o777).toBe(0o600);
    const second = await writeEnvFile({ root: dir, file: ".env.local", vars, confirmGitignore: async () => false });
    expect(second.action).toBe("unchanged");
  });
});
