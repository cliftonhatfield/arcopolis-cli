/**
 * `arcopolis version [--check]`: the CLI version; `--check` reads the static
 * release manifest once (no key, no telemetry, never automatic).
 */
import { CliError } from "../../core/errors.js";
import { npmSpec } from "../../init/init.js";
import { defineCommand, flagBoolean, objectSchema, type CommandSpec, type DocumentView } from "../spec.js";

/** Path of the static release manifest on the API host. */
export const MANIFEST_PATH = "/downloads/arcopolis-cli.json";

/** Compares dotted numeric versions (`0.10.0` > `0.9.3`). Pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] => (value.split("-")[0] ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function renderVersionHuman(view: DocumentView): string {
  const data = view.data as { version: string; latest?: string; updateAvailable?: boolean };
  const lines = [`arcopolis ${data.version}`];
  if (data.latest) {
    lines.push(data.updateAvailable ? `A newer version is available: ${data.latest}` : `Up to date (latest ${data.latest}).`);
  }
  return `${lines.join("\n")}\n`;
}

export const commands: CommandSpec[] = [
  defineCommand({
    name: "version",
    summary: "Print the CLI version; --check compares it with the published release manifest",
    phase: 1,
    credentials: "none",
    confirmation: "none",
    network: "none; --check: 1 GET of a static file",
    effects: { writes: [], spends: [] },
    flags: [{ name: "check", type: "boolean", description: "Fetch the release manifest once and report the latest version." }],
    positionals: [],
    errors: ["NOT_FOUND", "NON_JSON_RESPONSE", "EDGE_BLOCKED", "TIMEOUT", "NETWORK_ERROR", "INVALID_RESPONSE"],
    exitCodes: [0, 1, 2, 5, 11, 12],
    outputSchema: objectSchema(
      {
        version: { type: "string" },
        node: { type: "string" },
        platform: { type: "string" },
        latest: { type: "string" },
        updateAvailable: { type: "boolean" },
        manifestUrl: { type: "string" },
      },
      ["version", "node", "platform"],
    ),
    async run(ctx) {
      const data: Record<string, unknown> = {
        version: ctx.version,
        node: process.versions.node,
        platform: `${process.platform}-${process.arch}`,
      };
      if (!flagBoolean(ctx.flags, "check")) return { data };
      const client = ctx.createPublicClient();
      const response = await client.get<Record<string, unknown>>(MANIFEST_PATH, undefined, {
        envelope: false,
        auth: false,
        purpose: "read",
      });
      const latest = response.data.latest;
      if (typeof latest !== "string" || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(latest)) {
        throw new CliError("INVALID_RESPONSE", "The release manifest has no valid \"latest\" version.", {
          surface: "data",
          httpStatus: response.status,
          humanDecision: false,
        });
      }
      data.latest = latest;
      data.updateAvailable = compareVersions(latest, ctx.version) > 0;
      data.manifestUrl = `${client.base.url}${MANIFEST_PATH}`;
      return {
        data,
        next: data.updateAvailable
          ? [
              {
                command: `npm i -g ${npmSpec(latest)}`,
                why: `Install the newer version from npm (ask the human first). Without npm: npm i -g ${client.base.url}/downloads/arcopolis-cli-${latest}.tgz`,
                humanDecision: true,
              },
            ]
          : [],
      };
    },
    renderHuman: renderVersionHuman,
  }),
];
