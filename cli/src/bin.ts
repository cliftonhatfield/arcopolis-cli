#!/usr/bin/env node
/**
 * `arcopolis` entry point. The single exit point: `runCli` never throws and
 * returns the exit code; this file only sets `process.exitCode`, so stdout
 * is flushed before the process ends.
 */
import { runCli } from "./cli/main.js";

const exitCode = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
});
process.exitCode = exitCode;
