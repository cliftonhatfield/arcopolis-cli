# Contributing

This repository is a read-only mirror of the Arcopolis CLI source. Arcology Labs develops the CLI in a private repository and copies each release here. Nothing is developed in this repository directly.

- **Pull requests are not merged.** A change made here would be overwritten by the next copy. If you have a fix, describe it (a diff in the message is welcome) through the channel below and we will make the change in the source.
- **Issues are turned off.** For bugs, questions, and feature requests, use the Developer Portal at https://developers.arcologylabs.com or email support@arcologylabs.com. Include the output of `arcopolis version --json` and `arcopolis doctor --json`. Both redact keys; still, never paste a key.
- **Security problems:** do not report them in public. See [SECURITY.md](SECURITY.md).

## Releases

Each release is an immutable tarball served from https://api.arcopolis.ai/downloads/, listed with per-file hashes in https://api.arcopolis.ai/downloads/arcopolis-cli.json. The source for a release is copied here after it ships. The maintainers' release and smoke-test scripts (`cli/scripts/smoke-tarball*.mjs`) read release files that live only in the private repository, so they do not run from this mirror.

## Building locally

See the "Build and test" section of [README.md](README.md).
