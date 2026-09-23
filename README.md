# Arcopolis CLI

Source for `arcopolis`, the command-line client and MCP server for the Arcopolis Public API, from Arcology Labs.

This repository is a read-only mirror. The CLI is developed in Arcology Labs' private repository, and each release's source is copied here. Pull requests are not merged here; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Use it

The CLI ships as an immutable, versioned tarball. Pin the version:

```bash
npx -y --package=https://api.arcopolis.ai/downloads/arcopolis-cli-0.2.2.tgz arcopolis status --json
```

Install instructions, the agent quickstart, the output contract, and the security model are in [cli/README.md](cli/README.md).

- Developer Portal (keys, terms, guides): https://developers.arcologylabs.com
- API reference and OpenAPI contract: https://api.arcopolis.ai
- Release manifest (every version, with a SHA-256 for each packed file): https://api.arcopolis.ai/downloads/arcopolis-cli.json

## Layout

Paths match the private repository, so the tests run unchanged.

| Path | What it is |
|---|---|
| `cli/` | The `arcopolis` package: source, tests, and build configuration. |
| `developers/src/cli/envelope.ts` | The Developer Portal's side of one-approval setup. It encrypts the new keys to the CLI's public key. The CLI tests encrypt with it, so both sides are checked against each other. |
| `developers/src/cli/__fixtures__/grant-envelope-v1.json` | The shared, synthetic envelope test vector. |
| `api_site/openapi.json` | The published API contract, the same bytes as https://api.arcopolis.ai/openapi.json. |
| `examples/arcopolis-starter/node/` | The starter kit files the CLI's demo mode and visitor tests use, the same bytes as https://api.arcopolis.ai/starter/node/. |

## Build and test

Requires Node 22 or newer.

```bash
cd cli
npm ci
npm run build
npm run lint
npm test
```

The tests use fakes, loopback servers, and temp directories. They never touch the live network or real credentials.

## Check a release against this source

The release this snapshot corresponds to is `0.2.2`. To compare, build here and pack the same files the release packs:

```bash
cd cli
npm ci && npm run build
mkdir -p /tmp/arcopolis-pack/package
cp package.json README.md LICENSE /tmp/arcopolis-pack/package/
cp package-lock.json /tmp/arcopolis-pack/package/npm-shrinkwrap.json
cp -R dist /tmp/arcopolis-pack/package/dist
(cd /tmp/arcopolis-pack/package && npm pack --ignore-scripts --pack-destination ..)
```

Then compare the SHA-256 of each file in the resulting tarball with the entry for `0.2.2` in the release manifest. The compiled files under `dist/` and the dependency lock match the release. `README.md` can differ when the documentation changed after the release shipped; that change ships with the next version.

## License

MIT. See [LICENSE](LICENSE).
