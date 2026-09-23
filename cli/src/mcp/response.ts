/**
 * MCP tool results (plan §6). Success carries the CLI success envelope as
 * `structuredContent`; failure is the repo's `toolError` shape
 * (`structuredContent.error.{code, category, message, toolName, exitCode}`)
 * extended with the rest of the CLI error document. Every result goes
 * through the redactor, and a result that still holds a key-shaped secret
 * is withheld.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ErrorDocument, SuccessDocument } from "../core/output.js";
import { containsSecret, redact, redactSerialized, redactValue } from "../core/redact.js";

type Json = Record<string, unknown>;

/** Redacts property names as well as values (a key could arrive as an object key). */
function redactNames(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactNames(item));
  if (value && typeof value === "object") {
    const out: Json = {};
    for (const [name, item] of Object.entries(value as Json)) out[redact(name)] = redactNames(item);
    return out;
  }
  return value;
}

/** Deep redaction for anything returned to the MCP client. */
export function redactForClient<T>(value: T): T {
  return redactNames(redactValue(value)) as T;
}

/** The result that replaces one whose redacted form still contains a secret (never expected). */
function withheld(toolName: string): CallToolResult {
  const error = {
    category: "internal",
    code: "INTERNAL",
    message: "The tool result was withheld because it still contained a secret after redaction. This is a CLI bug.",
    toolName,
    exitCode: 1,
  };
  return {
    isError: true,
    content: [{ type: "text", text: `${toolName} failed: INTERNAL (exit 1): ${error.message}` }],
    structuredContent: { error },
  };
}

/**
 * Final gate: redact the whole result and refuse to return a key-shaped
 * string. Text content already holds a structurally redacted JSON document,
 * so it gets only the JSON-safe key and JWT pass: the plain-text header rule
 * would split an escaped quote in other agents' text and corrupt the JSON.
 */
function finalize(toolName: string, result: CallToolResult): CallToolResult {
  const content = result.content.map((item) =>
    item.type === "text" ? { ...item, text: redactSerialized(item.text) } : redactForClient(item),
  );
  const safe: CallToolResult = {
    ...result,
    content,
    ...(result.structuredContent ? { structuredContent: redactForClient(result.structuredContent) } : {}),
  };
  return containsSecret(JSON.stringify(safe)) ? withheld(toolName) : safe;
}

/** Success: `summary + "\n\n" + JSON` text plus the envelope as `structuredContent`. */
export function toolSuccess(toolName: string, summary: string, envelope: SuccessDocument): CallToolResult {
  const safe = redactForClient(envelope) as unknown as Json;
  return finalize(toolName, {
    content: [{ type: "text", text: `${redact(summary)}\n\n${JSON.stringify(safe, null, 2)}` }],
    structuredContent: safe,
  });
}

/** One line naming the failure, the hint, and the retry advice. */
function errorSummary(toolName: string, doc: ErrorDocument): string {
  const lines = [`${toolName} failed: ${doc.error.code} (exit ${doc.exitCode}, ${doc.error.category}): ${doc.error.message}`];
  if (doc.error.hint) lines.push(`Hint: ${doc.error.hint}`);
  if (doc.error.retry.strategy === "after_seconds" && doc.error.retry.afterSeconds !== undefined) {
    lines.push(`Retry after ${doc.error.retry.afterSeconds} seconds.`);
  } else if (doc.error.retry.strategy === "after_utc_reset" && doc.error.retry.resetsAt) {
    lines.push(`Budget resets at ${doc.error.retry.resetsAt}.`);
  }
  if (doc.humanAction && typeof doc.humanAction.tellTheHuman === "string") lines.push(`Tell the human exactly: ${doc.humanAction.tellTheHuman}`);
  if (doc.error.humanDecision) lines.push("This needs the human's decision before any retry.");
  return lines.join("\n");
}

/**
 * Error: `isError: true`, and `structuredContent` is the CLI error document
 * whose `error` also carries `toolName` and `exitCode` (the `toolError`
 * shape with the real API or CLI code).
 */
export function toolError(toolName: string, doc: ErrorDocument): CallToolResult {
  const structured: Json = { ...doc, error: { ...doc.error, toolName, exitCode: doc.exitCode } };
  const safe = redactForClient(structured);
  return finalize(toolName, {
    isError: true,
    content: [{ type: "text", text: `${redact(errorSummary(toolName, doc))}\n\n${JSON.stringify(safe, null, 2)}` }],
    structuredContent: safe,
  });
}
