/**
 * MCP diagnostics (plan §6): stdout carries only JSON-RPC, so everything
 * else goes to stderr as one redacted JSON line per event
 * (`{phase, server:"arcopolis", ts, details}`).
 */
import { Writable } from "node:stream";
import { mcpDiagnostic } from "../cli/context.js";
import type { TextSink, Writer } from "../core/redact.js";

/**
 * Writes one diagnostic line. The `mcp` command supplies it (its lines go to
 * the redacting stderr writer); tests pass a recorder.
 */
export type DiagnosticSink = (phase: string, details?: Record<string, unknown>) => void;

/** A sink that writes redacted `mcpDiagnostic` lines to `target`. */
export function createDiagnosticSink(target: TextSink, now: () => Date): DiagnosticSink {
  return (phase: string, details: Record<string, unknown> = {}): void => {
    target.write(mcpDiagnostic(phase, details, now()));
  };
}

/** Splits free text into lines; empty lines are dropped. */
function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "");
}

/**
 * A {@link Writer} that turns free text into diagnostic lines, one per text
 * line (tool code that writes to stdout or stderr never reaches stdout).
 */
export function diagnosticWriter(sink: DiagnosticSink, phase: string, details: Record<string, unknown> = {}): Writer {
  return {
    write(text: string): void {
      for (const line of lines(text)) sink(phase, { ...details, message: line });
    },
  };
}

/** A Node writable with the same behavior (for `rawStdout` / `rawStderr` in tool contexts). */
export function diagnosticStream(sink: DiagnosticSink, phase: string, details: Record<string, unknown> = {}): Writable {
  const writer = diagnosticWriter(sink, phase, details);
  return new Writable({
    write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      writer.write(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      callback();
    },
  });
}
