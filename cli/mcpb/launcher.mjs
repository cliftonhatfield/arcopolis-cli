/**
 * Entry point of the Arcopolis Desktop Extension (.mcpb). It runs exactly
 * `arcopolis mcp`, adding `--allow-writes` only when the "Allow visitor
 * actions" setting is on.
 *
 * MCPB substitutes a boolean setting into the manifest as the string "true"
 * or "false", and a manifest cannot add or drop an argument based on it, so
 * the setting arrives in ARCOPOLIS_MCPB_ALLOW_WRITES and this file turns it
 * into the flag. Anything but the exact string "true" stays read-only. The
 * CLI itself is the unmodified published package under dist/.
 */
import { runCli } from "./dist/cli/main.js";

const allowWrites = process.env.ARCOPOLIS_MCPB_ALLOW_WRITES === "true";
const env = { ...process.env };
delete env.ARCOPOLIS_MCPB_ALLOW_WRITES;

const exitCode = await runCli({
  argv: allowWrites ? ["mcp", "--allow-writes"] : ["mcp"],
  env,
  cwd: process.cwd(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
});
process.exitCode = exitCode;
