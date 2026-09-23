/**
 * `arcopolis env write PATH [--yes]` and `arcopolis env status [PATH]`
 * (plan §5 "Env file").
 *
 * `env write` puts the resolved keys into a managed `# arcopolis:start` …
 * `# arcopolis:end` block of an env file at 0600. It refuses a file git
 * tracks, and a file git does not ignore is first added to the `.gitignore`
 * managed block (after a TTY y/N or `--yes`). Only variable names and
 * redacted previews are printed. `env status` reports names only.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedCredentials, ResolvedKey } from "../../core/credentials.js";
import { CliError } from "../../core/errors.js";
import { ENV_VARIABLES, inspectEnvFile, renderEnvLines, writeEnvFile } from "../../core/envFile.js";
import { DEFAULT_IGNORE_ENTRIES, readManagedLines } from "../../core/gitignore.js";
import { findGitRoot } from "../../core/project.js";
import { redact } from "../../core/redact.js";
import { defineCommand, flagBoolean, objectSchema, type CommandContext, type CommandSpec, type DocumentView } from "../spec.js";
import { relativeDisplay, setCredentialEnvNames } from "./status.js";

/**
 * Refuses to hand a stored key to anything that would send it to a base
 * other than the origin it was saved for (plan §3.5): a custom base, or a
 * base on another origin. Environment keys may go to any allowed base.
 */
export function assertKeysMatchBase(ctx: CommandContext, keys: Array<ResolvedKey | null>): void {
  const base = ctx.store.apiBase();
  for (const key of keys) {
    if (!key || key.source !== "store") continue;
    if (base.kind === "custom" || key.origin !== base.origin) {
      throw new CliError(
        "STORED_KEY_ORIGIN_MISMATCH",
        `A stored key was saved for ${key.origin ?? "another origin"} and is never handed to a process that uses ${base.origin}.`,
        { hint: "Unset ARCOPOLIS_API_BASE, or supply the key through the environment for a custom base.", humanDecision: true },
      );
    }
  }
}

/**
 * The variables `exec` injects and `env write` writes, from the resolved
 * credentials: the data base, the read key, the drive key, and the agent id.
 */
export function credentialEnvVars(ctx: CommandContext, resolved: ResolvedCredentials): Record<string, string> {
  assertKeysMatchBase(ctx, [resolved.read, resolved.visitor]);
  const vars: Record<string, string> = { ARCOPOLIS_API_BASE: ctx.store.apiBase().url };
  if (resolved.read) vars.ARCOPOLIS_API_KEY = resolved.read.value;
  if (resolved.visitor) vars.ARCOPOLIS_VISITOR_API_KEY = resolved.visitor.value;
  if (resolved.visitor && resolved.agentId) vars.ARCOPOLIS_VISITOR_AGENT_ID = resolved.agentId.value;
  return vars;
}

/** Project root for env files: the git root, else cwd. */
async function envRoot(ctx: CommandContext): Promise<{ root: string; gitRoot: string | null }> {
  const gitRoot = await findGitRoot(ctx.cwd);
  return { root: gitRoot ?? ctx.cwd, gitRoot };
}

/** Env files the CLI created, from the non-default lines of the `.gitignore` managed block. */
async function managedEnvFiles(root: string): Promise<string[]> {
  let content = "";
  try {
    content = await readFile(path.join(root, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  return (readManagedLines(content) ?? []).map((line) => line.trim()).filter((line) => line && !DEFAULT_IGNORE_ENTRIES.includes(line));
}

interface EnvWriteData {
  path: string;
  action: "created" | "updated" | "unchanged" | "planned";
  fileMode: "0600";
  gitignore: { path: string; action: string; added: string[] } | null;
  variables: Array<{ name: string; preview: string }>;
  inRepo: boolean;
  demo?: boolean;
}

interface EnvStatusFile {
  path: string;
  exists: boolean;
  mode: string | null;
  tracked: boolean;
  ignored: boolean;
  inRepo: boolean;
  managedVariables: string[];
  ok: boolean;
  problems: string[];
}

function renderEnvWriteHuman(view: DocumentView): string {
  const data = view.data as EnvWriteData;
  const lines = [
    data.demo
      ? `Demo mode: would write ${data.path}; nothing was written.`
      : `${data.action === "unchanged" ? "Already up to date" : data.action === "created" ? "Created" : "Updated"}: ${data.path} (0600)`,
    ...data.variables.map((variable) => `  ${variable.name}=${variable.preview}`),
  ];
  if (data.gitignore && data.gitignore.added.length) lines.push(`Added to .gitignore: ${data.gitignore.added.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

function renderEnvStatusHuman(view: DocumentView): string {
  const data = view.data as { files: EnvStatusFile[]; environment: string[] };
  const lines: string[] = [];
  if (!data.files.length) lines.push("No env files managed by arcopolis.");
  for (const file of data.files) {
    lines.push(`${file.path}: ${file.exists ? `mode ${file.mode}` : "missing"}${file.ok ? ", ok" : `, ${file.problems.join("; ")}`}`);
    if (file.managedVariables.length) lines.push(`  managed: ${file.managedVariables.join(", ")}`);
  }
  if (data.environment.length) lines.push(`Set in this environment: ${data.environment.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

export const commands: CommandSpec[] = [
  defineCommand({
    name: "env write",
    summary: "Write the stored keys into a gitignored env file (managed block, 0600)",
    description:
      "Writes ARCOPOLIS_API_BASE, ARCOPOLIS_API_KEY, ARCOPOLIS_VISITOR_API_KEY, and ARCOPOLIS_VISITOR_AGENT_ID (those that " +
      "resolve) into the file's managed block. Refuses a file git tracks. A file git does not ignore is added to the " +
      ".gitignore managed block first, after a y/N prompt or --yes. Prints names and redacted previews only.",
    phase: 1,
    credentials: "stored",
    confirmation: "yes",
    network: "none",
    effects: { writes: ["env_file", "project_files"], spends: [] },
    flags: [{ name: "yes", type: "boolean", humanDecision: true, description: "Add the file to .gitignore without the y/N prompt." }],
    positionals: [{ name: "path", description: "Env file path.", required: true }],
    errors: [
      "ENV_FILE_TRACKED",
      "ENV_FILE_NOT_IGNORED",
      "CONFIRMATION_REQUIRED",
      "CONFIRMATION_DECLINED",
      "NO_CREDENTIALS",
      "STORED_KEY_ORIGIN_MISMATCH",
      "GITIGNORE_SYMLINK",
      "INVALID_PATH",
    ],
    exitCodes: [0, 1, 2, 3, 10],
    outputSchema: objectSchema(
      {
        path: { type: "string" },
        action: { enum: ["created", "updated", "unchanged", "planned"] },
        fileMode: { const: "0600" },
        gitignore: { type: ["object", "null"] },
        variables: { type: "array", items: { type: "object", properties: { name: { type: "string" }, preview: { type: "string" } } } },
        inRepo: { type: "boolean" },
      },
      ["path", "action", "variables"],
    ),
    examples: ["arcopolis env write .env.arcopolis --json", "arcopolis env write .env.local --yes"],
    async run(ctx) {
      const file = ctx.positionals[0] ?? "";
      if (!file.trim()) throw new CliError("MISSING_ARGUMENT", "Missing <path>: Env file path.", { humanDecision: false });
      const resolved = await ctx.store.resolved();
      if (!resolved.read && !resolved.visitor) {
        throw new CliError("NO_CREDENTIALS", "No key is configured, so there is nothing to write.", {
          hint: "Run arcopolis setup --json first.",
          next: [{ command: "arcopolis setup --json", why: "Get credentials with one human approval", humanDecision: false }],
        });
      }
      const vars = credentialEnvVars(ctx, resolved);
      const { root, gitRoot } = await envRoot(ctx);
      const target = path.resolve(ctx.cwd, file);
      if (ctx.mode.demo) {
        const variables = renderEnvLines(vars).map((line) => {
          const [name, ...rest] = line.split("=");
          return { name: name ?? "", preview: redact(rest.join("=")) };
        });
        const data: EnvWriteData = {
          path: relativeDisplay(ctx.cwd, target),
          action: "planned",
          fileMode: "0600",
          gitignore: null,
          variables,
          inRepo: gitRoot !== null,
          demo: true,
        };
        return { data };
      }
      const yes = flagBoolean(ctx.flags, "yes");
      const result = await writeEnvFile({
        root,
        file: target,
        vars,
        confirmGitignore: async (relative: string): Promise<boolean> => {
          if (yes) return true;
          if (!ctx.mode.interactive) {
            throw new CliError("CONFIRMATION_REQUIRED", `${relative} is not ignored by git; it must be added to .gitignore before keys go into it.`, {
              hint: "Add --yes only when the human asked for this env file. Or choose a path .gitignore already covers.",
              humanDecision: true,
            });
          }
          const confirmed = await ctx.confirm(`${relative} is not ignored by git. Add it to .gitignore and write the keys?`);
          if (!confirmed) {
            throw new CliError("CONFIRMATION_DECLINED", `${relative} was not written.`, { humanDecision: true });
          }
          return true;
        },
      });
      if (!result.inRepo) {
        ctx.warnings.add("ENV_FILE_NOT_IN_REPO", "The env file is not inside a git repository, so .gitignore was not checked.");
      }
      if (result.gitignore && result.gitignore.action !== "unchanged") ctx.effects.write("project_files");
      if (result.action !== "unchanged") {
        ctx.effects.write("env_file");
        for (const variable of result.variables) {
          if (/_KEY$/.test(variable.name)) ctx.effects.secretWritten(`env_file:${variable.name}`);
        }
      }
      const data: EnvWriteData = {
        path: relativeDisplay(ctx.cwd, result.path),
        action: result.action,
        fileMode: "0600",
        gitignore: result.gitignore
          ? { path: relativeDisplay(ctx.cwd, result.gitignore.path), action: result.gitignore.action, added: result.gitignore.added }
          : null,
        variables: result.variables,
        inRepo: result.inRepo,
      };
      return {
        data,
        next: [
          {
            command: "arcopolis exec -- <command>",
            why: "Or skip the file: exec injects the same variables without writing them anywhere",
            humanDecision: false,
          },
        ],
      };
    },
    renderHuman: renderEnvWriteHuman,
  }),
  defineCommand({
    name: "env status",
    summary: "Which env files and variables the CLI manages (names only)",
    description:
      "Lists the env files in the .gitignore managed block (and PATH, when given): mode, tracked, ignored, and the " +
      "variable names in each managed block. Also lists which ARCOPOLIS_* variables are set in this environment. Never prints values.",
    phase: 1,
    credentials: "none",
    confirmation: "none",
    network: "none",
    effects: { writes: [], spends: [] },
    flags: [],
    positionals: [{ name: "path", description: "Env file path (optional)." }],
    errors: [],
    exitCodes: [0, 1, 2],
    outputSchema: objectSchema(
      {
        root: { type: "string" },
        files: { type: "array", items: { type: "object" } },
        environment: { type: "array", items: { type: "string" } },
        variables: { type: "array", items: { type: "string" } },
      },
      ["files", "environment"],
    ),
    examples: ["arcopolis env status --json", "arcopolis env status .env.arcopolis"],
    async run(ctx) {
      const { root } = await envRoot(ctx);
      const candidates = new Set((await managedEnvFiles(root)).map((entry) => path.resolve(root, entry)));
      const explicit = ctx.positionals[0];
      if (explicit) candidates.add(path.resolve(ctx.cwd, explicit));
      const files: EnvStatusFile[] = [];
      for (const target of candidates) {
        const inspection = await inspectEnvFile(root, target);
        const problems: string[] = [];
        if (inspection.tracked) problems.push("tracked by git");
        if (inspection.repo && !inspection.ignored) problems.push("not ignored by git");
        if (inspection.exists && inspection.mode !== null && (Number.parseInt(inspection.mode, 8) & 0o077) !== 0) {
          problems.push(`mode ${inspection.mode} (expected 0600)`);
        }
        files.push({
          path: relativeDisplay(ctx.cwd, inspection.path),
          exists: inspection.exists,
          mode: inspection.mode,
          tracked: inspection.tracked,
          ignored: inspection.ignored,
          inRepo: inspection.repo,
          managedVariables: inspection.exists ? inspection.managedVariables : [],
          ok: inspection.exists && problems.length === 0,
          problems: inspection.exists ? problems : ["missing", ...problems],
        });
      }
      return {
        data: {
          root,
          files,
          environment: setCredentialEnvNames(ctx.env),
          variables: [...ENV_VARIABLES],
        },
      };
    },
    renderHuman: renderEnvStatusHuman,
  }),
];
