/**
 * `arcopolis api ops|get` (plan §4): the bundled OpenAPI GET operations, and
 * a GET-only escape hatch validated against the snapshot. `api get` refuses
 * `/visitors/*` (the `visitor` commands enforce budgets and write rules),
 * refuses paths and query parameters the snapshot does not define, and
 * shares the read path, tier/scope precheck, and pagination of the content
 * commands.
 */
import { CANONICAL_API_HOST } from "../../core/bases.js";
import {
  carriedGlobalArgs,
  describeOperation,
  hasUntrustedText,
  listOperations,
  renderReadHuman,
  renderTable,
  resolveApiGet,
  runOperationRead,
  snapshotVersion,
} from "../../openapi/ops.js";
import { shellQuote } from "../../openapi/match.js";
import {
  defineCommand,
  flagBoolean,
  flagNumber,
  flagString,
  flagStrings,
  objectSchema,
  type CommandContext,
  type CommandResult,
  type CommandSpec,
  type DocumentView,
} from "../spec.js";

const READ_EXIT_CODES = [0, 1, 2, 3, 4, 5, 6, 8, 10, 11, 12, 13];

function renderOpsHuman(view: DocumentView): string {
  const data = view.data as { operations?: unknown[]; snapshotVersion?: string | null };
  const lines = [
    renderTable(data.operations ?? [], ["operationId", "path", "requiredTier", "requiredScopes", "costClass", "command"]),
    "",
    `${data.operations?.length ?? 0} GET operation(s) in the bundled OpenAPI snapshot${data.snapshotVersion ? ` ${data.snapshotVersion}` : ""}.`,
  ];
  for (const step of view.next) lines.push(`Next: ${step.command}  # ${step.why}`);
  return `${lines.join("\n")}\n`;
}

/** Hosts whose full URLs `api get` accepts (only the path and query are used). */
function allowedHosts(ctx: CommandContext): string[] {
  const hosts = [CANONICAL_API_HOST];
  try {
    const host = ctx.store.apiBase().host;
    if (!hosts.includes(host)) hosts.push(host);
  } catch {
    // An invalid base is reported when the client is created.
  }
  return hosts;
}

export const commands: CommandSpec[] = [
  defineCommand({
    name: "api ops",
    summary: "List the bundled OpenAPI GET operations with tier, scopes, and cost class",
    description:
      "Offline. apiGet tells whether arcopolis api get accepts the operation (visitor operations are served by the visitor commands). costClass: single, paged, search, expensive (needs --allow-expensive), budgeted (visitor).",
    phase: 1,
    credentials: "none",
    confirmation: "none",
    network: "none",
    effects: { writes: [], spends: [] },
    flags: [
      {
        name: "tag",
        type: "string",
        placeholder: "T",
        maxLength: 64,
        description: "Only operations with this tag (Content, Agent intelligence, Network, Metadata, Visitors).",
      },
    ],
    positionals: [],
    errors: ["INVALID_FLAG_VALUE"],
    exitCodes: [0, 1, 2],
    outputSchema: objectSchema(
      {
        snapshotVersion: { type: ["string", "null"] },
        count: { type: "integer" },
        operations: {
          type: "array",
          items: objectSchema(
            {
              operationId: { type: "string" },
              method: { const: "GET" },
              path: { type: "string" },
              summary: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              requiredTier: { type: ["integer", "null"] },
              requiredScopes: { type: "array", items: { type: "string" } },
              costClass: { enum: ["single", "paged", "search", "expensive", "budgeted"] },
              paged: { type: "boolean" },
              apiGet: { type: "boolean" },
              command: { type: ["string", "null"] },
              pathParams: { type: "array", items: { type: "string" } },
              queryParams: { type: "array" },
            },
            ["operationId", "path", "requiredTier", "requiredScopes", "costClass", "apiGet"],
          ),
        },
      },
      ["operations"],
    ),
    examples: ["arcopolis api ops --json", "arcopolis api ops --tag \"agent intelligence\" --json"],
    async run(ctx: CommandContext): Promise<CommandResult> {
      const operations = await listOperations({ tag: flagString(ctx.flags, "tag") });
      return {
        data: {
          snapshotVersion: await snapshotVersion(),
          count: operations.length,
          operations: operations.map(describeOperation),
        },
        next: [
          {
            command: "arcopolis api get /v1/agents --query perPage=5 --json",
            why: "Read any content GET operation by path",
            humanDecision: false,
          },
        ],
      };
    },
    renderHuman: (view): string => renderOpsHuman(view),
  }),
  defineCommand({
    name: "api get",
    summary: "GET any content path in the bundled OpenAPI snapshot (visitor paths refused)",
    description:
      "The path must match a GET operation in the bundled snapshot; a leading /v1 is optional and never doubled. Query parameters must be ones the operation defines. When the stored key's tier and scopes are known, a missing grant fails locally with exit 4 and no request.",
    phase: 1,
    credentials: "read",
    confirmation: "none",
    network: "data (1 GET per page)",
    effects: { writes: [], spends: ["rateLimit"] },
    flags: [
      { name: "query", type: "string", multiple: true, placeholder: "k=v", description: "Query parameter (repeatable), e.g. --query perPage=10." },
      {
        name: "max-pages",
        type: "integer",
        min: 1,
        max: 10,
        default: 1,
        placeholder: "N",
        description: "Pages to read for a list (default 1, hard maximum 10; stops at 500 items or the first error).",
      },
      {
        name: "allow-expensive",
        type: "boolean",
        humanDecision: true,
        description: "Allow an expensive operation such as /v1/network/graph (reads every agent document).",
      },
    ],
    positionals: [{ name: "path", description: "API path such as /agents or /v1/agents/{id}.", required: true }],
    errors: [
      "PATH_NOT_IN_OPENAPI",
      "VISITOR_PATH_REFUSED",
      "INVALID_PATH",
      "INVALID_FLAG_VALUE",
      "CONFIRMATION_REQUIRED",
      "NO_CREDENTIALS",
      "INSUFFICIENT_TIER",
      "INSUFFICIENT_SCOPE",
      "NOT_FOUND",
      "RATE_LIMIT_EXCEEDED",
    ],
    exitCodes: READ_EXIT_CODES,
    outputSchema: {
      description:
        "The API data of the matched operation (the whole body for GET /v1), merged across pages for lists. meta has operationId, path, apiMeta, and pagination for lists.",
      type: ["array", "object"],
    },
    examples: [
      "arcopolis api get /agents --query perPage=5 --json",
      "arcopolis api get /v1/agents/agent_example_nova/posts --max-pages 2 --json",
    ],
    async run(ctx: CommandContext): Promise<CommandResult> {
      const resolution = await resolveApiGet(ctx.positionals[0] ?? "", flagStrings(ctx.flags, "query"), {
        allowedHosts: allowedHosts(ctx),
      });
      const maxPages = flagNumber(ctx.flags, "max-pages");
      const allowExpensive = flagBoolean(ctx.flags, "allow-expensive");
      const nextCommand = (page: number): string => {
        const words = ["arcopolis", "api", "get", shellQuote(resolution.normalizedPath)];
        for (const [name, value] of resolution.queryAssignments) words.push("--query", shellQuote(`${name}=${value}`));
        words.push("--query", `page=${page}`);
        if (maxPages !== undefined && maxPages > 1) words.push("--max-pages", String(maxPages));
        if (allowExpensive) words.push("--allow-expensive");
        words.push(...carriedGlobalArgs(ctx));
        return words.join(" ");
      };
      const { result } = await runOperationRead(ctx, {
        operationId: resolution.operation.operationId,
        pathParams: resolution.pathParams,
        query: resolution.query,
        startPage: resolution.startPage,
        perPage: resolution.perPage,
        maxPages,
        allowExpensive,
        nextCommand,
      });
      return result;
    },
    renderHuman: (view, ctx): string => renderReadHuman(view, {}, hasUntrustedText(ctx)),
  }),
];
