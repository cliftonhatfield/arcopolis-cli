/** `arcopolis init` (plan §7): templates, planning, idempotency, merges, and the npx-name guard. */
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BLOCK_END_LINE,
  codexConfigSnippet,
  detectInstall,
  importsAgentsMd,
  mcpStanza,
  readBlockVersion,
  npmSpec,
  tarballUrl,
  upsertMarkdownBlock,
} from "../src/init/init.js";
import {
  AGENTS_BLOCK,
  AGENTS_BLOCK_V1,
  CURSOR_RULE_FRONTMATTER,
  CURSOR_RULE_TEMPLATE,
  SKILL_FRONTMATTER,
  SKILL_TEMPLATE,
  BLOCK_VERSION,
} from "../src/init/templates.js";
import { CLI_VERSION } from "../src/version.js";
import { run, tempDir, type RunResult } from "./helpers.js";

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES_DIR = path.join(CLI_ROOT, "src", "init", "templates");
const PLAN_FILE = path.resolve(CLI_ROOT, "..", ".cursor", "plans", "arcopolis-cli.plan.md");
/**
 * The unpinned npm form must never be suggested (`npx arcopolis`, `npx -y arcopolis`,
 * `npx arcopolis@latest`): it runs whatever version npm resolves that day. The
 * canonical form is `npx -y arcopolis@<version>`.
 */
const BARE_NPX = /npx(\s+-y)?\s+arcopolis(?!@(?:\d+\.\d+\.\d+|<version>))(?![\w-])/;
const PINNED_NPX = `npx -y arcopolis@${CLI_VERSION}`;

let dir: string;
let cleanup: () => Promise<void>;
let configDir: string;
let cleanupConfig: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir("arcopolis-init-"));
  ({ dir: configDir, cleanup: cleanupConfig } = await tempDir("arcopolis-init-config-"));
  await mkdir(path.join(dir, ".git"));
});
afterEach(async () => {
  await cleanup();
  await cleanupConfig();
});

/** Runs `arcopolis <argv>` in the temp project with an isolated (unused) store. */
function init(argv: string[], cwd = dir): Promise<RunResult> {
  return run(["init", ...argv, "--json"], { cwd, env: { ARCOPOLIS_CONFIG_DIR: path.join(configDir, "store") } });
}

/** Every file under `root` (except `.git`) with its content, and symlinks with their targets. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (rel === ".git") continue;
      if (entry.isSymbolicLink()) out[rel] = `symlink -> ${await readlink(full)}`;
      else if (entry.isDirectory()) await walk(full);
      else out[rel] = await readFile(full, "utf8");
    }
  };
  await walk(root);
  return out;
}

interface FileEntry {
  path: string;
  action: string;
  reason?: string;
  command?: string;
  args?: string[];
  added?: string[];
}

function filesOf(result: RunResult): FileEntry[] {
  return ((result.json?.data as { files?: FileEntry[] } | undefined)?.files ?? []) as FileEntry[];
}

function fileEntry(result: RunResult, rel: string): FileEntry | undefined {
  return filesOf(result).find((file) => file.path === rel);
}

describe("templates", () => {
  it("the runtime constants match the template files byte for byte", () => {
    expect(readFileSync(path.join(TEMPLATES_DIR, "agents-block.md"), "utf8")).toBe(AGENTS_BLOCK);
    expect(readFileSync(path.join(TEMPLATES_DIR, "skill.md"), "utf8")).toBe(SKILL_TEMPLATE);
    expect(readFileSync(path.join(TEMPLATES_DIR, "cursor-rule.mdc"), "utf8")).toBe(CURSOR_RULE_TEMPLATE);
  });

  it.skipIf(!existsSync(PLAN_FILE))("the v1 block is verbatim from plan section 7", () => {
    const plan = readFileSync(PLAN_FILE, "utf8");
    const start = plan.indexOf("\n<!-- arcopolis:start v1 (") + 1;
    const end = plan.indexOf(BLOCK_END_LINE, start);
    expect(start).toBeGreaterThan(0);
    expect(`${plan.slice(start, end + BLOCK_END_LINE.length)}\n`).toBe(AGENTS_BLOCK_V1);
  });

  it("the current block has v2 markers; the Phase 1 block kept for upgrades has v1", () => {
    expect(AGENTS_BLOCK.startsWith("<!-- arcopolis:start v2 (managed by `arcopolis init`; edits inside are replaced) -->\n")).toBe(true);
    expect(AGENTS_BLOCK.endsWith(`${BLOCK_END_LINE}\n`)).toBe(true);
    expect(readBlockVersion(AGENTS_BLOCK)).toBe("v2");
    expect(BLOCK_VERSION).toBe("v2");
    expect(readBlockVersion(AGENTS_BLOCK_V1)).toBe("v1");
  });

  it("v2 restores the grant relay: link, code, resume, denial, expiry, and the MCP setup tools", () => {
    for (const phrase of [
      "`humanAction.tellTheHuman` exactly",
      "`humanAction.verificationUriComplete`",
      "`humanAction.userCode`",
      "resumes the same code",
      "APPROVAL_DENIED",
      "CLI_GRANT_EXPIRED",
      "arcopolis setup --new --json",
      "HUMAN_SETUP_REQUIRED",
      "arcopolis_setup_start",
      "arcopolis_setup_finish",
      "Never open a setup link, approve it, or accept terms yourself.",
    ]) {
      expect(AGENTS_BLOCK, phrase).toContain(phrase);
    }
  });

  it("the skill has valid frontmatter (name, description) and restates the block's rules", () => {
    const match = /^---\n([\s\S]*?)\n---\n/.exec(SKILL_TEMPLATE);
    expect(match).not.toBeNull();
    const fields = Object.fromEntries(
      (match?.[1] ?? "").split("\n").map((line) => {
        const colon = line.indexOf(": ");
        return [line.slice(0, colon), line.slice(colon + 2)];
      }),
    );
    expect(Object.keys(fields).sort()).toEqual(["description", "name"]);
    expect(fields.name).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(fields.name).toBe("arcopolis");
    const description = String(fields.description);
    expect(description.length).toBeGreaterThan(40);
    expect(description.length).toBeLessThanOrEqual(1024);
    // A YAML plain scalar: no `: `, no ` #`, no leading indicator character.
    expect(description).not.toMatch(/: | #/);
    expect(description).toMatch(/^[A-Za-z]/);
    expect(SKILL_TEMPLATE).toBe(`${SKILL_FRONTMATTER}${AGENTS_BLOCK}`);
  });

  it("the Cursor rule has description and alwaysApply: true frontmatter plus the block", () => {
    expect(CURSOR_RULE_FRONTMATTER).toMatch(/^---\ndescription: [^\n]+\nalwaysApply: true\n---\n\n$/);
    expect(CURSOR_RULE_TEMPLATE).toBe(`${CURSOR_RULE_FRONTMATTER}${AGENTS_BLOCK}`);
  });

  it("the unpinned-form guard rejects the unpinned forms and accepts the pinned one", () => {
    for (const bad of ["npx arcopolis status", "npx -y arcopolis mcp", "npx -y arcopolis@latest mcp", "npx arcopolis"]) {
      expect(bad).toMatch(BARE_NPX);
    }
    expect(`${PINNED_NPX} status`).not.toMatch(BARE_NPX);
    expect("npx -y --package=https://api.arcopolis.ai/downloads/arcopolis-cli-0.2.3.tgz arcopolis").not.toMatch(BARE_NPX);
  });

  it("no template or init source contains the unpinned npx package form", () => {
    const sources = [
      path.join(TEMPLATES_DIR, "agents-block.md"),
      path.join(TEMPLATES_DIR, "skill.md"),
      path.join(TEMPLATES_DIR, "cursor-rule.mdc"),
      path.join(CLI_ROOT, "src", "init", "templates.ts"),
      path.join(CLI_ROOT, "src", "init", "init.ts"),
      path.join(CLI_ROOT, "src", "cli", "commands", "init.ts"),
    ];
    for (const file of sources) expect(readFileSync(file, "utf8"), file).not.toMatch(BARE_NPX);
  });
});

describe("managed Markdown block", () => {
  it("appends after a blank line, then replaces in place without touching other text", () => {
    const first = upsertMarkdownBlock("# Project\n\nRules.\n", AGENTS_BLOCK);
    expect(first.changed).toBe(true);
    expect(first.hadBlock).toBe(false);
    expect(first.content).toBe(`# Project\n\nRules.\n\n${AGENTS_BLOCK}`);
    const second = upsertMarkdownBlock(first.content, AGENTS_BLOCK);
    expect(second).toMatchObject({ changed: false, hadBlock: true, content: first.content });

    const old = "<!-- arcopolis:start v0 (old) -->\n## Old rules\n- stale\n<!-- arcopolis:end -->";
    const withOld = `Intro\n\n${old}\n\nOutro line\n`;
    const replaced = upsertMarkdownBlock(withOld, AGENTS_BLOCK);
    expect(replaced.changed).toBe(true);
    expect(replaced.content).toBe(`Intro\n\n${AGENTS_BLOCK}\nOutro line\n`);
  });

  it("keeps CRLF line endings", () => {
    const content = "# Title\r\n\r\nText\r\n";
    const first = upsertMarkdownBlock(content, AGENTS_BLOCK);
    expect(first.content.startsWith(content)).toBe(true);
    expect(first.content.replace(/\r\n/g, "")).not.toContain("\n");
    const second = upsertMarkdownBlock(first.content, AGENTS_BLOCK);
    expect(second.changed).toBe(false);
  });

  it("ignores markers inside fenced code and refuses an unterminated block", () => {
    const fenced = `Docs\n\n\`\`\`markdown\n${AGENTS_BLOCK}\`\`\`\n`;
    const update = upsertMarkdownBlock(fenced, AGENTS_BLOCK);
    expect(update.hadBlock).toBe(false);
    expect(update.content.startsWith(fenced)).toBe(true);

    const broken = "<!-- arcopolis:start v1 -->\n## Arcopolis\n";
    expect(upsertMarkdownBlock(broken, AGENTS_BLOCK)).toMatchObject({ unterminated: true, changed: false, content: broken });
  });
});

describe("CLAUDE.md import detection", () => {
  it("detects @AGENTS.md and @./AGENTS.md imports", () => {
    expect(importsAgentsMd("# CLAUDE.md\n\n@AGENTS.md\n")).toBe(true);
    expect(importsAgentsMd("See @./AGENTS.md for rules.")).toBe(true);
    expect(importsAgentsMd("Rules live in @AGENTS.md.\r\n")).toBe(true);
  });

  it("ignores mentions that are not imports", () => {
    expect(importsAgentsMd("Read AGENTS.md first.")).toBe(false);
    expect(importsAgentsMd("Use `@AGENTS.md` to import.")).toBe(false);
    expect(importsAgentsMd("```\n@AGENTS.md\n```\n")).toBe(false);
    expect(importsAgentsMd("mail me@AGENTS.md")).toBe(false);
    expect(importsAgentsMd("@AGENTS.mdx")).toBe(false);
  });
});

describe("MCP stanza and install detection", () => {
  it("a global install runs arcopolis mcp; anything else runs the version-pinned npm package through npx", () => {
    expect(mcpStanza("global", "0.1.0", false)).toEqual({ command: "arcopolis", args: ["mcp"] });
    for (const install of ["npx", "local", "source"] as const) {
      expect(mcpStanza(install, "0.1.0", false)).toEqual({ command: "npx", args: ["-y", "arcopolis@0.1.0", "mcp"] });
    }
    expect(npmSpec(CLI_VERSION)).toBe(`arcopolis@${CLI_VERSION}`);
    expect(mcpStanza("global", "0.1.0", true).args).toEqual(["mcp", "--allow-writes"]);
    expect(mcpStanza("npx", "0.1.0", true).args.at(-1)).toBe("--allow-writes");
    expect(tarballUrl(CLI_VERSION)).toBe(`https://api.arcopolis.ai/downloads/arcopolis-cli-${CLI_VERSION}.tgz`);
  });

  it("the Codex snippet for a global install matches the plan exactly", () => {
    expect(codexConfigSnippet(mcpStanza("global", "0.1.0", false))).toBe(
      '[mcp_servers.arcopolis]\ncommand = "arcopolis"\nargs = ["mcp"]\nrequired = false\nstartup_timeout_sec = 45\n',
    );
    const npx = codexConfigSnippet(mcpStanza("npx", "0.1.0", true));
    expect(npx).toContain('command = "npx"');
    expect(npx).toContain('"--allow-writes"]');
    expect(npx).toContain('args = ["-y", "arcopolis@0.1.0", "mcp", "--allow-writes"]');
    expect(npx).not.toMatch(BARE_NPX);
  });

  it("classifies npx cache, global PATH installs, project installs, and checkouts", async () => {
    const pkg = path.join(dir, "prefix", "lib", "node_modules", "arcopolis");
    await mkdir(path.join(pkg, "dist", "init"), { recursive: true });
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "arcopolis" }));
    await writeFile(path.join(pkg, "dist", "bin.js"), "");
    const moduleFile = path.join(pkg, "dist", "init", "init.js");
    const binDir = path.join(dir, "prefix", "bin");
    await mkdir(binDir, { recursive: true });

    // Not on PATH yet: a node_modules install is "local".
    expect(await detectInstall({ moduleFile, pathEnv: binDir, platform: "darwin" })).toBe("local");
    await symlink(path.join(pkg, "dist", "bin.js"), path.join(binDir, "arcopolis"));
    expect(await detectInstall({ moduleFile, pathEnv: `/nonexistent:${binDir}`, platform: "darwin" })).toBe("global");

    // An `arcopolis` on PATH that belongs to another package is not this install.
    const other = path.join(dir, "other-bin");
    await mkdir(other);
    await writeFile(path.join(other, "arcopolis"), "#!/bin/sh\n");
    expect(await detectInstall({ moduleFile, pathEnv: other, platform: "darwin" })).toBe("local");

    // npm puts node_modules/.bin on PATH for npx and scripts; that never counts as global.
    const projectPkg = path.join(dir, "proj", "node_modules", "arcopolis");
    await mkdir(path.join(projectPkg, "dist", "init"), { recursive: true });
    await writeFile(path.join(projectPkg, "package.json"), JSON.stringify({ name: "arcopolis" }));
    await writeFile(path.join(projectPkg, "dist", "bin.js"), "");
    const dotBin = path.join(dir, "proj", "node_modules", ".bin");
    await mkdir(dotBin);
    await symlink(path.join(projectPkg, "dist", "bin.js"), path.join(dotBin, "arcopolis"));
    expect(
      await detectInstall({ moduleFile: path.join(projectPkg, "dist", "init", "init.js"), pathEnv: dotBin, platform: "darwin" }),
    ).toBe("local");

    const npxFile = path.join(os.homedir(), ".npm", "_npx", "abc123", "node_modules", "arcopolis", "dist", "init", "init.js");
    expect(await detectInstall({ moduleFile: npxFile, pathEnv: binDir, platform: "darwin" })).toBe("npx");
    expect(await detectInstall({ moduleFile: path.join(CLI_ROOT, "src", "init", "init.ts"), pathEnv: undefined, platform: "darwin" })).toBe(
      "source",
    );
  });
});

describe("arcopolis init", () => {
  it("prints the plan-shaped document and writes AGENTS.md, .gitignore, and arcopolis.json by default", async () => {
    const result = await init([]);
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "init",
      exitCode: 0,
      data: { agent: "generic", targets: ["generic"], dryRun: false },
      effects: { network: [], requests: 0, writes: ["project_files"], spends: {}, secretsWritten: [] },
      next: [{ command: "arcopolis setup --json", humanDecision: false }],
    });
    expect(filesOf(result)).toEqual([
      { path: "AGENTS.md", action: "created", block: "v2" },
      { path: ".gitignore", action: "created", added: [".arcopolis-*", ".arcopolis/"] },
      { path: "arcopolis.json", action: "created" },
    ]);
    expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toBe(AGENTS_BLOCK);
    expect(await readFile(path.join(dir, ".gitignore"), "utf8")).toBe("# arcopolis:start\n.arcopolis-*\n.arcopolis/\n# arcopolis:end\n");
    expect(JSON.parse(await readFile(path.join(dir, "arcopolis.json"), "utf8"))).toEqual({
      $schema: "https://api.arcopolis.ai/cli/arcopolis.schema.json",
      schemaVersion: 1,
      profile: "default",
    });
    // The generic target still returns the Codex snippet (the user config is never edited).
    expect((result.json?.data as { codexConfigSnippet?: string }).codexConfigSnippet).toContain("[mcp_servers.arcopolis]");
    // init never touches the credential store.
    expect(existsSync(path.join(configDir, "store"))).toBe(false);
  });

  it("is idempotent: a second run changes nothing and reports every file unchanged", async () => {
    await writeFile(path.join(dir, "AGENTS.md"), "# Agents\n\nExisting rules.\n");
    await writeFile(path.join(dir, ".gitignore"), "node_modules/\n");
    const first = await init(["--agent", "all", "--skill"]);
    expect(first.exitCode).toBe(0);
    const afterFirst = await snapshot(dir);
    const second = await init(["--agent", "all", "--skill"]);
    expect(second.exitCode).toBe(0);
    expect(await snapshot(dir)).toEqual(afterFirst);
    for (const file of filesOf(second)) expect(file.action, file.path).toBe("unchanged");
    expect((second.json?.effects as { writes: string[] }).writes).toEqual([]);
    expect(filesOf(first).map((file) => file.path)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      ".mcp.json",
      ".claude/skills/arcopolis/SKILL.md",
      ".cursor/rules/arcopolis.mdc",
      ".cursor/mcp.json",
      ".gitignore",
      "arcopolis.json",
    ]);
    expect(fileEntry(first, "AGENTS.md")?.action).toBe("created_block");
    expect(afterFirst["AGENTS.md"]).toBe(`# Agents\n\nExisting rules.\n\n${AGENTS_BLOCK}`);
    expect(afterFirst[".gitignore"]).toBe("node_modules/\n# arcopolis:start\n.arcopolis-*\n.arcopolis/\n# arcopolis:end\n");
    expect(afterFirst[".claude/skills/arcopolis/SKILL.md"]).toBe(SKILL_TEMPLATE);
    expect(afterFirst[".cursor/rules/arcopolis.mdc"]).toBe(CURSOR_RULE_TEMPLATE);
  });

  it("upgrades an installed v1 block to v2 in every file in place; a second run changes nothing", async () => {
    await mkdir(path.join(dir, ".cursor", "rules"), { recursive: true });
    await writeFile(path.join(dir, "AGENTS.md"), `# Agents\n\n${AGENTS_BLOCK_V1}\n## After\n`);
    await writeFile(path.join(dir, ".cursor", "rules", "arcopolis.mdc"), `${CURSOR_RULE_FRONTMATTER}${AGENTS_BLOCK_V1}`);
    const first = await init(["--agent", "all"]);
    expect(first.exitCode).toBe(0);
    expect(fileEntry(first, "AGENTS.md")).toMatchObject({ action: "updated_block", block: "v2" });
    expect(fileEntry(first, ".cursor/rules/arcopolis.mdc")).toMatchObject({ action: "updated_block", block: "v2" });
    expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toBe(`# Agents\n\n${AGENTS_BLOCK}\n## After\n`);
    expect(await readFile(path.join(dir, ".cursor", "rules", "arcopolis.mdc"), "utf8")).toBe(CURSOR_RULE_TEMPLATE);
    const second = await init(["--agent", "all"]);
    for (const file of filesOf(second)) expect(file.action, file.path).toBe("unchanged");
    const status = await run(["status"], { env: { ARCOPOLIS_CONFIG_DIR: configDir }, cwd: dir });
    expect(status.json).toMatchObject({ data: { project: { agentInstructions: "v2" } } });
  });

  it("replaces an older block in place and keeps the surrounding text", async () => {
    const old = "<!-- arcopolis:start v0 (managed) -->\n## Arcopolis\n- old rule\n<!-- arcopolis:end -->\n";
    await writeFile(path.join(dir, "AGENTS.md"), `# Top\n\n${old}\n## Bottom\n`);
    const result = await init(["--agent", "generic"]);
    expect(fileEntry(result, "AGENTS.md")?.action).toBe("updated_block");
    expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toBe(`# Top\n\n${AGENTS_BLOCK}\n## Bottom\n`);
  });

  it("merges .mcp.json and .cursor/mcp.json, keeping other servers and keys", async () => {
    const claudeMcp = {
      mcpServers: {
        other: { command: "other-server", args: ["--flag"], env: { OTHER: "1" } },
        arcopolis: { command: "old", args: [], env: { ARCOPOLIS_PROFILE: "work" } },
      },
      extra: true,
    };
    await writeFile(path.join(dir, ".mcp.json"), JSON.stringify(claudeMcp, null, 2));
    await mkdir(path.join(dir, ".cursor"));
    await writeFile(path.join(dir, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { docs: { url: "https://example.test/mcp" } } }));
    const result = await init(["--agent", "all"]);
    expect(result.exitCode).toBe(0);
    const merged = JSON.parse(await readFile(path.join(dir, ".mcp.json"), "utf8")) as typeof claudeMcp;
    expect(merged.extra).toBe(true);
    expect(merged.mcpServers.other).toEqual(claudeMcp.mcpServers.other);
    expect(Object.keys(merged.mcpServers)).toEqual(["other", "arcopolis"]);
    expect(merged.mcpServers.arcopolis).toEqual({
      command: "npx",
      args: ["-y", `arcopolis@${CLI_VERSION}`, "mcp"],
      env: { ARCOPOLIS_PROFILE: "work" },
    });
    expect(fileEntry(result, ".mcp.json")).toMatchObject({ action: "merged", command: "npx" });
    const cursor = JSON.parse(await readFile(path.join(dir, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(cursor.mcpServers.docs).toEqual({ url: "https://example.test/mcp" });
    expect(cursor.mcpServers.arcopolis).toMatchObject({ command: "npx" });
  });

  it("--mcp-writes appends --allow-writes; --no-mcp writes no stanza and no snippet", async () => {
    const writes = await init(["--agent", "claude", "--mcp-writes"]);
    const stanza = JSON.parse(await readFile(path.join(dir, ".mcp.json"), "utf8")) as { mcpServers: { arcopolis: { args: string[] } } };
    expect(stanza.mcpServers.arcopolis.args.at(-1)).toBe("--allow-writes");
    expect((writes.json?.data as { mcp: { allowWrites: boolean } }).mcp.allowWrites).toBe(true);
    expect((writes.json?.data as { codexConfigSnippet: string }).codexConfigSnippet).toContain('"--allow-writes"');

    // A later read-only run drops --allow-writes again.
    await init(["--agent", "claude"]);
    const readOnly = JSON.parse(await readFile(path.join(dir, ".mcp.json"), "utf8")) as { mcpServers: { arcopolis: { args: string[] } } };
    expect(readOnly.mcpServers.arcopolis.args).not.toContain("--allow-writes");

    const { dir: other, cleanup: cleanupOther } = await tempDir("arcopolis-init-nomcp-");
    try {
      await mkdir(path.join(other, ".git"));
      const noMcp = await init(["--agent", "all", "--no-mcp"], other);
      expect(noMcp.exitCode).toBe(0);
      expect(existsSync(path.join(other, ".mcp.json"))).toBe(false);
      expect(existsSync(path.join(other, ".cursor", "mcp.json"))).toBe(false);
      expect(noMcp.json?.data).not.toHaveProperty("codexConfigSnippet");
      expect((noMcp.json?.data as { mcp: unknown }).mcp).toBeNull();
    } finally {
      await cleanupOther();
    }
  });

  it("rejects contradictory MCP flags with exit 2 and writes nothing", async () => {
    const both = await init(["--mcp", "--no-mcp"]);
    expect(both.exitCode).toBe(2);
    expect((both.json?.error as { code: string }).code).toBe("USAGE_ERROR");
    const writesWithout = await init(["--no-mcp", "--mcp-writes"]);
    expect(writesWithout.exitCode).toBe(2);
    const badAgent = await init(["--agent", "vim"]);
    expect(badAgent.exitCode).toBe(2);
    expect(await snapshot(dir)).toEqual({});
  });

  it("leaves CLAUDE.md unchanged when it imports @AGENTS.md and puts the block in AGENTS.md", async () => {
    const claude = "# CLAUDE.md\n\n@AGENTS.md\n\nClaude-specific notes.\n";
    await writeFile(path.join(dir, "CLAUDE.md"), claude);
    await writeFile(path.join(dir, "AGENTS.md"), "# Agents\n");
    const result = await init(["--agent", "claude"]);
    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(dir, "CLAUDE.md"), "utf8")).toBe(claude);
    expect(fileEntry(result, "CLAUDE.md")).toEqual({ path: "CLAUDE.md", action: "unchanged", reason: "imports @AGENTS.md" });
    expect(fileEntry(result, "AGENTS.md")).toMatchObject({ action: "created_block", block: "v2" });
    expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toBe(`# Agents\n\n${AGENTS_BLOCK}`);
    expect(fileEntry(result, ".mcp.json")?.action).toBe("created");
  });

  it("adds the block to CLAUDE.md when it does not import AGENTS.md", async () => {
    await writeFile(path.join(dir, "CLAUDE.md"), "# CLAUDE.md\n\nRead AGENTS.md too.\n");
    const result = await init(["--agent", "claude"]);
    expect(fileEntry(result, "CLAUDE.md")?.action).toBe("created_block");
    expect(fileEntry(result, "AGENTS.md")).toBeUndefined();
    expect(await readFile(path.join(dir, "CLAUDE.md"), "utf8")).toContain(AGENTS_BLOCK);
    expect(existsSync(path.join(dir, "AGENTS.md"))).toBe(false);
  });

  it("writes through a CLAUDE.md -> AGENTS.md symlink once and keeps the symlink", async () => {
    await writeFile(path.join(dir, "AGENTS.md"), "# Shared rules\n");
    await symlink("AGENTS.md", path.join(dir, "CLAUDE.md"));
    const result = await init([]);
    expect(result.json?.data).toMatchObject({ agent: "auto", targets: ["generic", "claude"] });
    expect(fileEntry(result, "CLAUDE.md")).toMatchObject({ action: "unchanged", reason: "same file as AGENTS.md" });
    expect((await lstat(path.join(dir, "CLAUDE.md"))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toBe(`# Shared rules\n\n${AGENTS_BLOCK}`);
  });

  it("auto-detects .cursor/ and writes the rule and Cursor MCP file", async () => {
    await mkdir(path.join(dir, ".cursor"));
    const result = await init([]);
    expect(result.json?.data).toMatchObject({ agent: "cursor", targets: ["cursor"], detected: [".cursor/"] });
    expect(await readFile(path.join(dir, ".cursor", "rules", "arcopolis.mdc"), "utf8")).toBe(CURSOR_RULE_TEMPLATE);
    expect(existsSync(path.join(dir, ".cursor", "mcp.json"))).toBe(true);
    expect(existsSync(path.join(dir, "AGENTS.md"))).toBe(false);
  });

  it("--agent none writes only .gitignore and arcopolis.json and keeps an existing arcopolis.json", async () => {
    const project = '{"schemaVersion": 1, "profile": "work"}\n';
    await writeFile(path.join(dir, "arcopolis.json"), project);
    const result = await init(["--agent", "none"]);
    expect(filesOf(result).map((file) => `${file.path}:${file.action}`)).toEqual([".gitignore:created", "arcopolis.json:unchanged"]);
    expect(await readFile(path.join(dir, "arcopolis.json"), "utf8")).toBe(project);
    expect(result.json?.data).not.toHaveProperty("codexConfigSnippet");
  });

  it("--dry-run and --demo print the plan and write nothing", async () => {
    await writeFile(path.join(dir, "CLAUDE.md"), "# Notes\n");
    await writeFile(path.join(dir, ".mcp.json"), '{"mcpServers":{"other":{"command":"x"}}}');
    const before = await snapshot(dir);
    for (const flag of ["--dry-run", "--demo"]) {
      const result = await init(["--agent", "all", "--skill", flag]);
      expect(result.exitCode, flag).toBe(0);
      expect(await snapshot(dir)).toEqual(before);
      expect(result.json).toMatchObject({ ok: true, data: { dryRun: true }, meta: { dryRun: true } });
      expect((result.json?.effects as { writes: string[] }).writes).toEqual([]);
      expect(filesOf(result).map((file) => `${file.path}:${file.action}`)).toEqual([
        "AGENTS.md:created",
        "CLAUDE.md:created_block",
        ".mcp.json:merged",
        ".claude/skills/arcopolis/SKILL.md:created",
        ".cursor/rules/arcopolis.mdc:created",
        ".cursor/mcp.json:created",
        ".gitignore:created",
        "arcopolis.json:created",
      ]);
      expect((result.json?.next as Array<{ command: string }>)[0]?.command).toBe("arcopolis init --agent all --skill --json");
    }
  });

  it("skips files it cannot edit safely and says why", async () => {
    await writeFile(path.join(dir, "AGENTS.md"), "<!-- arcopolis:start v1 -->\nhalf a block\n");
    await writeFile(path.join(dir, "CLAUDE.md"), "# Claude\n");
    await writeFile(path.join(dir, ".mcp.json"), "{ not json");
    const before = await snapshot(dir);
    const result = await init(["--agent", "all"]);
    expect(result.exitCode).toBe(0);
    expect(fileEntry(result, "AGENTS.md")).toMatchObject({ action: "skipped" });
    expect(fileEntry(result, ".mcp.json")).toMatchObject({ action: "skipped" });
    const after = await snapshot(dir);
    expect(after["AGENTS.md"]).toBe(before["AGENTS.md"]);
    expect(after[".mcp.json"]).toBe(before[".mcp.json"]);
    const codes = (result.json?.warnings as Array<{ code: string }>).map((warning) => warning.code);
    expect(codes).toEqual(expect.arrayContaining(["INIT_BLOCK_UNTERMINATED", "INIT_MCP_JSON_INVALID"]));
  });

  it("warns when --skill is given without the claude target", async () => {
    const result = await init(["--agent", "generic", "--skill"]);
    expect((result.json?.warnings as Array<{ code: string }>).map((warning) => warning.code)).toContain("INIT_SKILL_IGNORED");
    expect(existsSync(path.join(dir, ".claude"))).toBe(false);
  });

  it("uses the project root from a subdirectory", async () => {
    const sub = path.join(dir, "packages", "app");
    await mkdir(sub, { recursive: true });
    const result = await init(["--agent", "generic"], sub);
    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(dir, "AGENTS.md"))).toBe(true);
    expect(existsSync(path.join(sub, "AGENTS.md"))).toBe(false);
  });

  it("never prints the unpinned npx package form in JSON or human output", async () => {
    const jsonRun = await init(["--agent", "all", "--skill", "--mcp-writes"]);
    expect(jsonRun.stdout).not.toMatch(BARE_NPX);
    expect(jsonRun.stdout).toContain(`arcopolis@${CLI_VERSION}`);
    expect(jsonRun.stderr).not.toMatch(BARE_NPX);
    const human = await run(["init", "--agent", "all", "--output", "human"], {
      cwd: dir,
      env: { ARCOPOLIS_CONFIG_DIR: path.join(configDir, "store") },
    });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("unchanged");
    expect(human.stdout).toContain("~/.codex/config.toml");
    expect(human.stdout).not.toMatch(BARE_NPX);
    const dry = await run(["init", "--dry-run", "--output", "human"], { cwd: dir, env: { ARCOPOLIS_CONFIG_DIR: path.join(configDir, "store") } });
    expect(dry.stdout).not.toMatch(BARE_NPX);
    expect(dry.stdout.trimStart().startsWith("{")).toBe(true);
    for (const file of Object.values(await snapshot(dir))) expect(file).not.toMatch(BARE_NPX);
  });

  it("--help --json describes the command", async () => {
    const result = await run(["init", "--help", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ ok: true, meta: { help: true }, data: { name: "init", network: "none" } });
    expect(result.stdout).not.toMatch(BARE_NPX);
  });
});
