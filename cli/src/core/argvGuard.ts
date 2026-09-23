/**
 * Refuses secrets on the command line (plan §3.6). Runs before any parsing,
 * over every argument including those after `--`.
 */
import { CliError } from "./errors.js";

/** A full-length `agnts_…` secret (32 or more hex characters). */
export const SECRET_ARGUMENT_PATTERN = /agnts_(?:[a-z]+_)*[0-9a-f]{32,}/;

export const SECRET_IN_ARGUMENTS_MESSAGE =
  "Keys in arguments land in shell history and agent transcripts. Use `arcopolis auth import --stdin`.";

/** Index of the first argument holding a secret, or -1. */
export function findSecretArgument(argv: readonly string[]): number {
  return argv.findIndex((arg) => SECRET_ARGUMENT_PATTERN.test(arg));
}

/** Throws `SECRET_IN_ARGUMENTS` (exit 2) when any argument holds a secret. Never echoes the argument. */
export function assertNoSecretArguments(argv: readonly string[]): void {
  const index = findSecretArgument(argv);
  if (index === -1) return;
  throw new CliError("SECRET_IN_ARGUMENTS", SECRET_IN_ARGUMENTS_MESSAGE, {
    hint: "Pipe the key instead: arcopolis auth import --stdin, or set it in the environment.",
    details: { argumentIndex: index },
    humanDecision: false,
  });
}
