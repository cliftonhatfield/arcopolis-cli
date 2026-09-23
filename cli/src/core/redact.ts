/**
 * Secret redaction (plan §3.6). One writer wraps stdout, stderr, `--verbose`
 * traces, and MCP results, so a key can never reach a transcript by accident.
 */

/** Any `agnts_…` secret: optional type segments, then at least 16 hex characters. */
export const KEY_PATTERN = /agnts_(?:[a-z]+_)*[0-9a-f]{16,}/g;

/** JWT-shaped tokens. */
export const JWT_PATTERN = /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g;

/**
 * Credential header values in traces, JSON, or header dumps:
 * `X-API-Key: v`, `"Authorization":"Bearer v"`, `Idempotency-Key=v`.
 * The value stops at a backslash as well, so an escaped quote inside a
 * string is never split. This rule is for plain text only: never run it
 * over serialized JSON (use {@link serializeRedacted}).
 */
export const HEADER_VALUE_PATTERN = /((?:X-API-Key|Authorization|Idempotency-Key)"?\s*[:=]\s*"?)([^"\\\r\n,}]+)/gi;

/** Placeholder for a redacted header value. */
export const REDACTED = "[redacted]";

const SECRET_HEADER_NAMES = new Set(["x-api-key", "authorization", "idempotency-key"]);

/**
 * Short, safe preview of one key: the type prefix plus the first four hex
 * characters and an ellipsis (`agnts_3f9a…`, `agnts_dc_91b2…`).
 */
export function redactKey(key: string): string {
  const match = /^(agnts_(?:[a-z]+_)*)([0-9a-f]{4})[0-9a-f]*$/.exec(key);
  if (match) return `${match[1]}${match[2]}…`;
  if (key.length <= 4) return "…";
  return `${key.slice(0, 4)}…`;
}

/** Redacts every secret shape in a string. Idempotent. */
export function redact(text: string): string {
  return text
    .replace(KEY_PATTERN, (match) => redactKey(match))
    .replace(JWT_PATTERN, "eyJ…[jwt]")
    .replace(HEADER_VALUE_PATTERN, (_match, prefix: string, value: string) =>
      value.trim() === REDACTED ? `${prefix}${value}` : `${prefix}${REDACTED}`,
    );
}

/**
 * Redacts only the key and JWT shapes. Both consist of characters that never
 * appear in JSON syntax (quotes, backslashes, commas, braces), so this is safe
 * on serialized JSON; the header rule is not.
 */
export function redactSerialized(text: string): string {
  return text.replace(KEY_PATTERN, (match) => redactKey(match)).replace(JWT_PATTERN, "eyJ…[jwt]");
}

/**
 * `JSON.stringify` of a structurally redacted copy ({@link redactValue}),
 * then {@link redactSerialized}. The result is always valid JSON, whatever
 * text other agents wrote into the value.
 */
export function serializeRedacted(value: unknown, space?: number): string {
  return redactSerialized(JSON.stringify(redactValue(value), null, space));
}

/** True when the string still contains a full key-shaped secret. */
export function containsSecret(text: string): boolean {
  KEY_PATTERN.lastIndex = 0;
  JWT_PATTERN.lastIndex = 0;
  return KEY_PATTERN.test(text) || JWT_PATTERN.test(text);
}

/**
 * Deep copy with secrets removed: strings (and property names) are redacted,
 * values under credential header names are replaced, and a JWK private part
 * (`d`) is dropped. Use it on anything that leaves the process as structured
 * data (JSON documents on stdout, MCP `structuredContent`).
 */
export function redactValue<T>(value: T): T {
  return redactInner(value) as T;
}

function redactInner(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactInner(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const isJwk = typeof record.kty === "string";
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      if (isJwk && key === "d") continue;
      if (SECRET_HEADER_NAMES.has(key.toLowerCase()) && item !== null && item !== undefined) {
        out[redact(key)] = REDACTED;
        continue;
      }
      out[redact(key)] = redactInner(item);
    }
    return out;
  }
  return value;
}

/** Minimal sink the redacting writers wrap (a stream or a test buffer). */
export interface TextSink {
  write(chunk: string): unknown;
}

/** A writer whose every write is redacted. */
export interface Writer {
  write(text: string): void;
}

/**
 * Wraps a sink so every `write` is redacted. Callers write whole strings
 * (documents, lines); for byte streams use {@link createLineRedactor}.
 */
export function createRedactingWriter(sink: TextSink): Writer {
  return {
    write(text: string): void {
      sink.write(redact(text));
    },
  };
}

/** Line-buffered redactor for child-process output (a secret split across chunks is still caught). */
export interface LineRedactor {
  push(chunk: string | Uint8Array): void;
  flush(): void;
}

/** Characters a key, a JWT, or a bare token can contain. A flush never cuts inside a run of them. */
const TOKEN_CHAR = /[\w.-]/;
const HEADER_NAME = /X-API-Key|Authorization|Idempotency-Key/gi;
/** What may follow a header name while its value can still be growing. */
const OPEN_HEADER_TAIL = /^"?\s*(?:[:=]\s*"?[^"\\\r\n,}]*)?$/;
/** Secret starts searched for when the hard cap forces a flush inside one long token. */
const SECRET_STARTS = ["agnts_", "eyJ"] as const;

function isTokenChar(char: string | undefined): boolean {
  return char !== undefined && TOKEN_CHAR.test(char);
}

/**
 * The longest prefix of `buffer` (which has no newline) that can be redacted
 * on its own: it never ends inside a run of token characters (the run may be
 * the start of a key or JWT still arriving) and never inside a credential
 * header whose value may continue. Returns 0 when nothing is safe yet.
 */
export function safeFlushPoint(buffer: string): number {
  let cut = buffer.length;
  for (;;) {
    const before = cut;
    while (cut > 0 && isTokenChar(buffer[cut - 1]) && (cut === buffer.length || isTokenChar(buffer[cut]))) cut -= 1;
    const head = buffer.slice(0, cut);
    HEADER_NAME.lastIndex = 0;
    for (let match = HEADER_NAME.exec(head); match; match = HEADER_NAME.exec(head)) {
      if (OPEN_HEADER_TAIL.test(head.slice(match.index + match[0].length))) {
        cut = match.index;
        break;
      }
    }
    if (cut === before || cut === 0) return cut;
  }
}

/**
 * Buffers input until a newline and writes each complete line redacted.
 * A line longer than `maxBuffer` is flushed early, but only up to
 * {@link safeFlushPoint}, so a key straddling the flush is never split into
 * two harmless-looking halves. A single token longer than 16 × `maxBuffer`
 * is flushed up to the last possible secret start. Call `flush()` when the
 * source ends to emit the last partial line.
 */
export function createLineRedactor(sink: TextSink, maxBuffer = 64 * 1024): LineRedactor {
  let buffer = "";
  const decoder = new TextDecoder();
  const hardMax = maxBuffer * 16;
  const emit = (end: number): void => {
    if (end <= 0) return;
    sink.write(redact(buffer.slice(0, end)));
    buffer = buffer.slice(end);
  };
  return {
    push(chunk: string | Uint8Array): void {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const newline = buffer.lastIndexOf("\n");
      if (newline !== -1) emit(newline + 1);
      if (buffer.length <= maxBuffer) return;
      const cut = safeFlushPoint(buffer);
      if (cut > 0) {
        emit(cut);
        return;
      }
      if (buffer.length <= hardMax) return;
      const windowStart = Math.max(0, buffer.length - 4096);
      let end = buffer.length - 8;
      for (const marker of SECRET_STARTS) {
        const index = buffer.lastIndexOf(marker);
        if (index >= windowStart) end = Math.min(end, index);
      }
      emit(end);
    },
    flush(): void {
      buffer += decoder.decode();
      if (buffer) sink.write(redact(buffer));
      buffer = "";
    },
  };
}
