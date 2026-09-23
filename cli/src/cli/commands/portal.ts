/**
 * `arcopolis portal [--visitor] [--open]` (plan §4): prints the developer
 * portal page where a human creates keys (`/start/read`) or registers a
 * visitor (`/start/agent`), plus the matching docs link. The CLI holds no
 * control-plane credential, so this is how keys, apps, and visitors are
 * managed. `--open` opens a browser only in an interactive terminal.
 */
import { spawn } from "node:child_process";
import { PORTAL_ORIGIN } from "../../core/bases.js";
import type { Env } from "../../core/credentials.js";
import { defineCommand, flagBoolean, objectSchema, type CommandSpec, type DocumentView } from "../spec.js";

/** Portal page for a new read key (app + key, Developer/API Terms). */
export const PORTAL_READ_URL = `${PORTAL_ORIGIN}/start/read`;
/** Portal page for registering a visitor and its drive key. */
export const PORTAL_AGENT_URL = `${PORTAL_ORIGIN}/start/agent`;
/** Developer docs: read path and visitor keys. */
export const DOCS_READ_URL = "https://api.arcopolis.ai/docs/api/developer/getting-started";
export const DOCS_AGENT_URL = "https://api.arcopolis.ai/docs/api/developer/visitor-keys";

/** The portal page and docs link for a read key or a visitor. */
export function portalLinks(purpose: "read" | "agent"): { url: string; docs: string } {
  return purpose === "agent" ? { url: PORTAL_AGENT_URL, docs: DOCS_AGENT_URL } : { url: PORTAL_READ_URL, docs: DOCS_READ_URL };
}

/** How long to wait for the opener's exit status before assuming it worked. */
const OPENER_WAIT_MS = 1_500;

/**
 * Whether a browser opened here would be in front of the person. False over
 * SSH (it would open on the remote machine) and on Linux or BSD with no
 * display; WSL is allowed because its opener reaches the Windows browser.
 */
export function canOpenBrowser(platform: NodeJS.Platform, env: Env): boolean {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
  if (platform === "darwin" || platform === "win32") return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY || env.WSL_DISTRO_NAME);
}

/**
 * Opens a URL in the default browser without a shell (`open`, `xdg-open`,
 * or `explorer.exe`). Resolves true only when the opener exits 0 (or is
 * still running after a short wait), and false when there is nowhere to
 * open it or the opener fails, so callers never claim a browser opened when
 * it did not. `explorer.exe` exits 1 even on success, so on Windows a
 * started opener counts.
 */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform, env: Env = process.env): Promise<boolean> {
  if (!canOpenBrowser(platform, env)) return Promise.resolve(false);
  const [command, args] =
    platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["explorer.exe", [url]] : ["xdg-open", [url]];
  return new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: boolean): void => {
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    try {
      const child = spawn(command, args as string[], { stdio: "ignore", detached: true, shell: false, windowsHide: true });
      child.once("error", () => finish(false));
      child.once("spawn", () => {
        child.unref();
        if (platform === "win32") finish(true);
        else timer = setTimeout(() => finish(true), OPENER_WAIT_MS);
      });
      child.once("exit", (code) => finish(platform === "win32" || code === 0));
    } catch {
      finish(false);
    }
  });
}

interface PortalData {
  url: string;
  purpose: "read" | "agent";
  docs: string;
  portal: string;
  opened: boolean;
}

function renderPortalHuman(view: DocumentView): string {
  const data = view.data as PortalData;
  const lines = [
    data.purpose === "agent" ? "Register a visitor and its drive key:" : "Create an app and a read key:",
    `  ${data.url}${data.opened ? "   (opened in your browser)" : ""}`,
    `Docs: ${data.docs}`,
    "Keys are shown once. Put them in your secret settings or run arcopolis auth import; never paste them into chat.",
  ];
  return `${lines.join("\n")}\n`;
}

export const commands: CommandSpec[] = [
  defineCommand({
    name: "portal",
    summary: "Print the developer portal URL for keys, apps, and visitors",
    description:
      "The CLI never creates apps or keys itself. This prints the page where a person does it: /start/read for a read key, " +
      "/start/agent (with --visitor) for a visitor. --open opens it only in an interactive terminal.",
    phase: 1,
    credentials: "none",
    confirmation: "none",
    network: "none",
    effects: { writes: [], spends: [] },
    flags: [
      { name: "visitor", type: "boolean", description: "Link the visitor page (/start/agent) instead of the read-key page." },
      { name: "open", type: "boolean", description: "Also open it in a browser (interactive terminal only)." },
    ],
    positionals: [],
    errors: [],
    exitCodes: [0, 1, 2],
    outputSchema: objectSchema(
      {
        url: { type: "string" },
        purpose: { enum: ["read", "agent"] },
        docs: { type: "string" },
        portal: { type: "string" },
        opened: { type: "boolean" },
      },
      ["url", "purpose", "docs", "portal", "opened"],
    ),
    examples: ["arcopolis portal --json", "arcopolis portal --visitor --open"],
    async run(ctx) {
      const purpose = flagBoolean(ctx.flags, "visitor") ? "agent" : "read";
      const links = portalLinks(purpose);
      let opened = false;
      if (flagBoolean(ctx.flags, "open")) {
        if (!ctx.mode.interactive || ctx.mode.demo || ctx.mode.mcp) {
          ctx.warnings.add("OPEN_SKIPPED", "Not opening a browser in a non-interactive session; give the URL to the human.");
        } else {
          opened = await openInBrowser(links.url, process.platform, ctx.env);
          if (!opened) ctx.warnings.add("OPEN_FAILED", "Could not start a browser; open the URL yourself.");
        }
      }
      const data: PortalData = { url: links.url, purpose, docs: links.docs, portal: PORTAL_ORIGIN, opened };
      return { data };
    },
    renderHuman: renderPortalHuman,
  }),
];
