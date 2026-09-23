import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AGENT_MARKERS, authorizeLiveWrite, detectInteractivity, promptConfirm, promptHidden } from "../src/core/interactive.js";

const tty = { stdinIsTTY: true, stdoutIsTTY: true, noInputFlag: false };

describe("non-interactive detection", () => {
  it("a TTY with a clean environment is interactive", () => {
    expect(detectInteractivity({ ...tty, env: {} })).toEqual({ interactive: true, reasons: [] });
  });

  it.each([
    [{ ...tty, stdinIsTTY: false, env: {} }, "stdin_not_tty"],
    [{ ...tty, stdoutIsTTY: false, env: {} }, "stdout_not_tty"],
    [{ ...tty, noInputFlag: true, env: {} }, "no_input_flag"],
    [{ ...tty, env: { ARCOPOLIS_NO_INPUT: "1" } }, "env:ARCOPOLIS_NO_INPUT"],
    [{ ...tty, env: { CI: "true" } }, "env:CI"],
    [{ ...tty, env: { CLAUDECODE: "1" } }, "agent:CLAUDECODE"],
  ])("%o is non-interactive (%s)", (input, reason) => {
    const result = detectInteractivity(input);
    expect(result.interactive).toBe(false);
    expect(result.reasons).toContain(reason);
  });

  it("CI=false, CI=0, and CLAUDECODE=0 do not count", () => {
    expect(detectInteractivity({ ...tty, env: { CI: "false" } }).interactive).toBe(true);
    expect(detectInteractivity({ ...tty, env: { CI: "0" } }).interactive).toBe(true);
    expect(detectInteractivity({ ...tty, env: { CLAUDECODE: "0" } }).interactive).toBe(true);
    expect(AGENT_MARKERS.map((marker) => marker.name)).toContain("CLAUDECODE");
  });
});

describe("prompts", () => {
  function streams(): { stdin: PassThrough; stderr: { text: string; write(chunk: string): boolean } } {
    const stderr = {
      text: "",
      write(chunk: string): boolean {
        this.text += chunk;
        return true;
      },
    };
    return { stdin: new PassThrough(), stderr };
  }

  it("non-interactive confirm and hidden prompts exit 10 without reading", async () => {
    const io = streams();
    await expect(promptConfirm("Send?", { interactive: false, streams: io })).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
      exitCode: 10,
    });
    await expect(promptHidden("Key:", { interactive: false, streams: io })).rejects.toMatchObject({ code: "INPUT_REQUIRED", exitCode: 10 });
    expect(io.stderr.text).toBe("");
  });

  it("confirm accepts only y/yes", async () => {
    const yes = streams();
    const pending = promptConfirm("Send?", { interactive: true, streams: yes });
    yes.stdin.write("y\n");
    await expect(pending).resolves.toBe(true);
    expect(yes.stderr.text).toBe("Send? [y/N] ");
    const no = streams();
    const declined = promptConfirm("Send?", { interactive: true, streams: no });
    no.stdin.write("\n");
    await expect(declined).resolves.toBe(false);
  });

  it("times out with exit 10", async () => {
    const io = streams();
    await expect(promptConfirm("Send?", { interactive: true, streams: io, timeoutMs: 20 })).rejects.toMatchObject({
      code: "PROMPT_TIMEOUT",
      exitCode: 10,
    });
  });

  it("hidden prompt reads a line without echoing it", async () => {
    const io = streams();
    const pending = promptHidden("Key:", { interactive: true, streams: io });
    io.stdin.write("secret-value\n");
    await expect(pending).resolves.toBe("secret-value");
    expect(io.stderr.text).not.toContain("secret-value");
  });
});

describe("write authorization", () => {
  const base = { previewMessage: "Preview only.", previewData: { preview: 1 }, question: "Send it?" };

  it("deny blocks every write with exit 4", async () => {
    await expect(
      authorizeLiveWrite({ ...base, execute: true, interactive: true, writePolicy: "deny", confirm: async () => true }),
    ).rejects.toMatchObject({ code: "WRITES_DISABLED", exitCode: 4 });
  });

  it("flag: --execute is enough; without it a non-TTY gets exit 10 with the preview", async () => {
    await expect(
      authorizeLiveWrite({ ...base, execute: true, interactive: false, writePolicy: "flag", confirm: async () => false }),
    ).resolves.toBe("execute_flag");
    await expect(
      authorizeLiveWrite({ ...base, execute: false, interactive: false, writePolicy: "flag", confirm: async () => true }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED", exitCode: 10, humanDecision: true, data: { preview: 1 } });
    await expect(
      authorizeLiveWrite({ ...base, execute: false, interactive: true, writePolicy: "flag", confirm: async () => true }),
    ).resolves.toBe("tty_prompt");
    await expect(
      authorizeLiveWrite({ ...base, execute: false, interactive: true, writePolicy: "flag", confirm: async () => false }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_DECLINED", exitCode: 10 });
  });

  it("tty-only needs an interactive yes even with --execute", async () => {
    await expect(
      authorizeLiveWrite({ ...base, execute: true, interactive: false, writePolicy: "tty-only", confirm: async () => true }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    await expect(
      authorizeLiveWrite({ ...base, execute: true, interactive: true, writePolicy: "tty-only", confirm: async () => true }),
    ).resolves.toBe("tty_prompt");
  });
});
