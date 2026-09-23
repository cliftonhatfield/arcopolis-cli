import { describe, expect, it } from "vitest";
import { SECRET_IN_ARGUMENTS_MESSAGE, assertNoSecretArguments, findSecretArgument } from "../src/core/argvGuard.js";
import { CliError } from "../src/core/errors.js";
import { fakeKey, run } from "./helpers.js";

describe("argv guard", () => {
  it("finds a secret in any argument, including after --", () => {
    expect(findSecretArgument(["status"])).toBe(-1);
    expect(findSecretArgument(["auth", "import", fakeKey()])).toBe(2);
    expect(findSecretArgument(["exec", "--", "node", `--key=${fakeKey("b")}`])).toBe(3);
    expect(findSecretArgument([`agnts_dc_${"1".repeat(32)}`])).toBe(0);
  });

  it("ignores short or non-hex lookalikes", () => {
    expect(findSecretArgument([`agnts_${"a".repeat(31)}`])).toBe(-1);
    expect(findSecretArgument(["agnts_example_key"])).toBe(-1);
  });

  it("throws SECRET_IN_ARGUMENTS with exit 2 and never echoes the key", () => {
    try {
      assertNoSecretArguments(["x", fakeKey()]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      const cliError = error as CliError;
      expect(cliError.code).toBe("SECRET_IN_ARGUMENTS");
      expect(cliError.exitCode).toBe(2);
      expect(cliError.message).toBe(SECRET_IN_ARGUMENTS_MESSAGE);
      expect(JSON.stringify(cliError.details)).not.toContain("agnts_a");
    }
  });

  it("the runner refuses before parsing and prints no key", async () => {
    const key = fakeKey("c");
    const result = await run(["auth", "import", key]);
    expect(result.exitCode).toBe(2);
    expect(result.json?.command).toBe("auth import");
    expect((result.json?.error as { code: string }).code).toBe("SECRET_IN_ARGUMENTS");
    expect(result.stdout + result.stderr).not.toContain(key);
  });
});
