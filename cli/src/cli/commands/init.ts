/**
 * `arcopolis init` (plan §7): the local, idempotent agent-instruction drop.
 *
 * No network and no credentials. It writes the v1 managed block into the
 * agent instruction files, merges the MCP stanza into `.mcp.json` /
 * `.cursor/mcp.json`, adds the `.gitignore` block, and creates the
 * `arcopolis.json` skeleton. The Codex user config is never edited; its TOML
 * is returned in `data.codexConfigSnippet`. `--dry-run` (and `--demo`) print
 * the plan without writing. The edits are reversible and hold no secrets, so
 * a run applies directly, with no prompt, in and out of a TTY.
 */
import {
  INIT_AGENTS,
  applyInitPlan,
  currentModuleFile,
  detectInstall,
  planInit,
  type InitAgent,
  type InitFileReport,
  type InitOptions,
  type InitPlan,
} from "../../init/init.js";
import {
  defineCommand,
  flagBoolean,
  flagString,
  objectSchema,
  usageError,
  type CommandContext,
  type CommandResult,
  type CommandSpec,
  type DocumentView,
  type NextStep,
} from "../spec.js";

/** `data` of a successful `init` document. */
interface InitData {
  agent: string;
  targets: string[];
  detected: string[];
  root: string;
  dryRun: boolean;
  files: InitFileReport[];
  mcp: InitPlan["mcp"];
  codexConfigSnippet?: string;
}

/** Re-creates the flags of this run for a `next` step (never includes --demo or --dry-run). */
function applyCommand(options: InitOptions, mcpFlag: boolean): string {
  const parts = ["arcopolis init", `--agent ${options.agent}`];
  if (!options.mcp) parts.push("--no-mcp");
  else if (mcpFlag) parts.push("--mcp");
  if (options.mcpWrites) parts.push("--mcp-writes");
  if (options.skill) parts.push("--skill");
  parts.push("--json");
  return parts.join(" ");
}

/** Builds the document `data` from a plan. */
function toData(plan: InitPlan, dryRun: boolean): InitData {
  const data: InitData = {
    agent: plan.agent,
    targets: [...plan.targets],
    detected: [...plan.detected],
    root: plan.root,
    dryRun,
    files: plan.files.map((file) => file.report),
    mcp: plan.mcp,
  };
  if (plan.codexConfigSnippet) data.codexConfigSnippet = plan.codexConfigSnippet;
  return data;
}

/** One human line per file. */
function fileLine(file: InitFileReport): string {
  const notes: string[] = [];
  if (file.reason) notes.push(file.reason);
  if (file.resolvedPath) notes.push(`writes ${file.resolvedPath}`);
  if (file.command && file.args) notes.push(`${file.server ?? "arcopolis"}: ${[file.command, ...file.args].join(" ")}`);
  if (file.added?.length) notes.push(`added ${file.added.join(", ")}`);
  return `  ${file.action.padEnd(14)} ${file.path}${notes.length ? ` (${notes.join("; ")})` : ""}`;
}

/** Human rendering: the plan as JSON for a dry run, else a file list plus the Codex snippet. */
function renderInit(view: DocumentView): string {
  const data = view.data as InitData;
  const nextLines = view.next.map(
    (step) => `Next: ${step.command}${step.humanDecision ? " (ask the human first)" : ""}  # ${step.why}`,
  );
  if (data.dryRun) return `${JSON.stringify(data, null, 2)}\n${nextLines.length ? `${nextLines.join("\n")}\n` : ""}`;
  const lines = [`arcopolis init (${data.agent}) in ${data.root}`, ...data.files.map(fileLine)];
  if (data.codexConfigSnippet) {
    lines.push("", "Codex is not edited. To use the MCP server there, add this to ~/.codex/config.toml:");
    lines.push(...data.codexConfigSnippet.trimEnd().split("\n").map((line) => `  ${line}`));
  }
  if (nextLines.length) lines.push("", ...nextLines);
  return `${lines.join("\n")}\n`;
}

export const commands: CommandSpec[] = [
  defineCommand({
    name: "init",
    summary: "Add the Arcopolis agent instructions, MCP stanza, .gitignore block, and arcopolis.json",
    description:
      "Local and idempotent: managed blocks (<!-- arcopolis:start v1 … --> … <!-- arcopolis:end -->) are replaced in place, " +
      "MCP JSON files are merged (other servers are kept), and CLAUDE.md is left unchanged when it imports @AGENTS.md. " +
      "--agent auto detects CLAUDE.md or .claude/, .cursor/, and AGENTS.md (nothing found: AGENTS.md). " +
      "The Codex user config is never edited; its TOML is returned in data.codexConfigSnippet. " +
      "The MCP stanza runs `arcopolis mcp` from a global install, otherwise the version-pinned npm package through npx -y arcopolis@<version>. " +
      "--dry-run prints the plan without writing; a non-TTY run applies directly (the edits are reversible and hold no secrets).",
    phase: 1,
    credentials: "none",
    confirmation: "none",
    network: "none",
    effects: { writes: ["project_files"], spends: [] },
    flags: [
      {
        name: "agent",
        type: "string",
        enum: INIT_AGENTS,
        default: "auto",
        placeholder: INIT_AGENTS.join("|"),
        description: "Which agent files to write (auto detects CLAUDE.md/.claude/, .cursor/, AGENTS.md).",
      },
      { name: "mcp", type: "boolean", description: "Write the read-only MCP stanza (the default)." },
      { name: "no-mcp", type: "boolean", description: "Do not write an MCP stanza or return the Codex snippet." },
      {
        name: "mcp-writes",
        type: "boolean",
        humanDecision: true,
        description: "Register the MCP write tools (appends --allow-writes to the stanza).",
      },
      { name: "skill", type: "boolean", description: "Also write .claude/skills/arcopolis/SKILL.md (claude target)." },
      { name: "dry-run", type: "boolean", description: "Print the plan as JSON without writing anything." },
    ],
    positionals: [],
    errors: ["USAGE_ERROR", "UNKNOWN_FLAG", "INVALID_FLAG_VALUE", "INIT_WRITE_FAILED", "INTERNAL"],
    exitCodes: [0, 1, 2, 4],
    outputSchema: objectSchema(
      {
        agent: { type: "string" },
        targets: { type: "array", items: { type: "string", enum: ["generic", "codex", "claude", "cursor"] } },
        detected: { type: "array", items: { type: "string" } },
        root: { type: "string" },
        dryRun: { type: "boolean" },
        files: {
          type: "array",
          items: objectSchema(
            {
              path: { type: "string" },
              action: {
                type: "string",
                enum: ["created", "created_block", "updated_block", "merged", "updated", "unchanged", "skipped"],
              },
              block: { type: "string" },
              reason: { type: "string" },
              server: { type: "string" },
              command: { type: "string" },
              args: { type: "array", items: { type: "string" } },
              added: { type: "array", items: { type: "string" } },
              resolvedPath: { type: "string" },
            },
            ["path", "action"],
          ),
        },
        mcp: {
          type: ["object", "null"],
          properties: {
            server: { type: "string" },
            command: { type: "string" },
            args: { type: "array", items: { type: "string" } },
            install: { type: "string", enum: ["global", "npx", "local", "source"] },
            allowWrites: { type: "boolean" },
          },
        },
        codexConfigSnippet: { type: "string" },
      },
      ["agent", "targets", "root", "dryRun", "files"],
    ),
    examples: ["arcopolis init --json", "arcopolis init --agent claude --skill --dry-run --json", "arcopolis init --agent codex --no-mcp"],
    async run(ctx: CommandContext): Promise<CommandResult> {
      const mcpFlag = flagBoolean(ctx.flags, "mcp");
      const noMcp = flagBoolean(ctx.flags, "no-mcp");
      const mcpWrites = flagBoolean(ctx.flags, "mcp-writes");
      if (mcpFlag && noMcp) throw usageError("--mcp and --no-mcp cannot be combined.", "Pass one of them (the MCP stanza is written by default).");
      if (noMcp && mcpWrites) throw usageError("--mcp-writes needs the MCP stanza, so it cannot be combined with --no-mcp.");
      const dryRun = flagBoolean(ctx.flags, "dry-run") || ctx.mode.demo;
      const options: InitOptions = {
        cwd: ctx.cwd,
        agent: (flagString(ctx.flags, "agent") ?? "auto") as InitAgent,
        mcp: !noMcp,
        mcpWrites,
        skill: flagBoolean(ctx.flags, "skill"),
        version: ctx.version,
        install: await detectInstall({
          moduleFile: currentModuleFile(),
          pathEnv: ctx.env.PATH ?? ctx.env.Path,
          platform: process.platform,
        }),
      };

      const plan = await planInit(options);
      for (const warning of plan.warnings) ctx.warnings.add(warning.code, warning.message);

      let next: NextStep[];
      const meta: Record<string, unknown> = {};
      if (dryRun) {
        meta.dryRun = true;
        next = [
          {
            command: applyCommand(options, mcpFlag),
            why: ctx.mode.demo ? "Demo mode wrote nothing; run without --demo to apply this plan" : "Apply this plan (local files only)",
            humanDecision: options.mcpWrites,
          },
        ];
      } else {
        const written = await applyInitPlan(plan);
        if (written.length > 0) ctx.effects.write("project_files");
        meta.written = written.length;
        next = [{ command: "arcopolis setup --json", why: "Get credentials with one human approval", humanDecision: false }];
      }
      return { data: toData(plan, dryRun), meta, next };
    },
    renderHuman(view: DocumentView): string {
      return renderInit(view);
    },
  }),
];
