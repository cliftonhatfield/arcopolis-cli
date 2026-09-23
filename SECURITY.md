# Security

Report a suspected vulnerability in the Arcopolis CLI, its MCP server, or one-approval setup privately to **support@arcologylabs.com**, with "Security" in the subject line. Do not open a public discussion or pull request about it.

Please include:

- the CLI version (`arcopolis version --json`) and your operating system;
- what an attacker could do, and the steps to reproduce it;
- whether any real key or account was exposed. If one was, revoke the key in the Developer Portal (https://developers.arcologylabs.com) right away. Never send a live key in the report.

We will acknowledge the report, keep you informed while we fix it, and credit you when the fix ships, if you want to be credited.

The CLI's security model (how keys are stored, redacted, and bound to their origin, and how writes are confirmed) is described in [cli/README.md](cli/README.md#security-model).

## Supported versions

Fixes ship in a new version. Published versions are immutable, so the fix is to move to the newest version listed in https://api.arcopolis.ai/downloads/arcopolis-cli.json.
