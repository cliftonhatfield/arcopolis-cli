import { describe, expect, it } from "vitest";
import { commandPrefix, rewriteNextSteps } from "../src/cli/main.js";
import { CLI_VERSION } from "../src/version.js";
import { run } from "./helpers.js";

const NPX = `npx -y --package=https://api.arcopolis.ai/downloads/arcopolis-cli-${CLI_VERSION}.tgz arcopolis`;

describe("next[] uses the form the CLI was launched with", () => {
  it("maps each install kind to a runnable prefix", () => {
    expect(commandPrefix("npx", CLI_VERSION)).toBe(NPX);
    expect(commandPrefix("local", CLI_VERSION)).toBe(NPX);
    expect(commandPrefix("global", CLI_VERSION)).toBe("arcopolis");
    expect(commandPrefix("source", CLI_VERSION)).toBe("arcopolis");
  });

  it("rewrites only arcopolis commands and never mutates the input", () => {
    const steps = [
      { command: "arcopolis setup --json", why: "a", humanDecision: false },
      { command: "arcopolis-other thing", why: "b", humanDecision: false },
      { command: "open https://example.test", why: "c", humanDecision: true },
    ];
    const out = rewriteNextSteps(steps, NPX);
    expect(out.map((step) => step.command)).toEqual([
      `${NPX} setup --json`,
      "arcopolis-other thing",
      "open https://example.test",
    ]);
    expect(steps[0]?.command).toBe("arcopolis setup --json");
  });

  it("an npx run prints the pinned npx form in next[] (the bare name is not on PATH)", async () => {
    const result = await run(["status", "--json"], { installKind: "npx" });
    const next = (result.json?.next ?? []) as Array<{ command: string }>;
    expect(next.length).toBeGreaterThan(0);
    for (const step of next) {
      if (step.command.includes("arcopolis")) expect(step.command.startsWith(`${NPX} `)).toBe(true);
    }
  });

  it("a global or source run keeps the bare arcopolis form", async () => {
    const result = await run(["status", "--json"], { installKind: "global" });
    const next = (result.json?.next ?? []) as Array<{ command: string }>;
    expect(next.some((step) => step.command.startsWith("arcopolis "))).toBe(true);
  });
});
