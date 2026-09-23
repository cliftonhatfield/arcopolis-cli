import { describe, expect, it } from "vitest";
import {
  REDACTED,
  containsSecret,
  createLineRedactor,
  createRedactingWriter,
  redact,
  redactKey,
  redactValue,
  safeFlushPoint,
  serializeRedacted,
} from "../src/core/redact.js";

const key = `agnts_3f9a${"0".repeat(60)}`;
const deviceCode = `agnts_dc_91b2${"c".repeat(60)}`;
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuv";

describe("redact", () => {
  it("shortens keys to the type prefix plus 4 hex", () => {
    expect(redact(`key=${key}`)).toBe("key=agnts_3f9a…");
    expect(redact(deviceCode)).toBe("agnts_dc_91b2…");
    expect(redactKey(key)).toBe("agnts_3f9a…");
    expect(redactKey(deviceCode)).toBe("agnts_dc_91b2…");
  });

  it("redacts 16+ hex secrets but leaves short hex alone", () => {
    expect(redact(`agnts_${"a".repeat(16)}`)).toBe("agnts_aaaa…");
    expect(redact("agnts_abc")).toBe("agnts_abc");
  });

  it("redacts JWT shapes", () => {
    expect(redact(`token ${jwt} end`)).toBe("token eyJ…[jwt] end");
  });

  it("redacts credential header values in traces and JSON", () => {
    expect(redact("X-API-Key: something-secret")).toBe(`X-API-Key: ${REDACTED}`);
    expect(redact('{"Authorization":"Bearer abc.def"}')).toBe(`{"Authorization":"${REDACTED}"}`);
    expect(redact("Idempotency-Key=action-123")).toBe(`Idempotency-Key=${REDACTED}`);
    expect(redact("x-api-key: v")).toBe(`x-api-key: ${REDACTED}`);
  });

  it("is idempotent", () => {
    const once = redact(`${key} X-API-Key: v ${jwt}`);
    expect(redact(once)).toBe(once);
    expect(containsSecret(once)).toBe(false);
    expect(containsSecret(key)).toBe(true);
  });

  it("redactValue walks objects, strips header values and JWK d", () => {
    const value = redactValue({
      nested: [{ text: `use ${key}` }],
      headers: { "X-API-Key": key, Accept: "application/json" },
      jwk: { kty: "EC", crv: "P-256", x: "x", y: "y", d: "private" },
      count: 3,
    });
    expect(JSON.stringify(value)).not.toContain(key);
    expect(value.nested[0]?.text).toBe("use agnts_3f9a…");
    expect(value.headers["X-API-Key"]).toBe(REDACTED);
    expect(value.headers.Accept).toBe("application/json");
    expect(value.jwk).not.toHaveProperty("d");
    expect(value.count).toBe(3);
  });
});

describe("redacting writers", () => {
  it("redacts every write", () => {
    const chunks: string[] = [];
    const writer = createRedactingWriter({ write: (chunk: string) => chunks.push(chunk) });
    writer.write(`{"key":"${key}"}\n`);
    expect(chunks.join("")).toBe('{"key":"agnts_3f9a…"}\n');
  });

  it("line redactor catches a key split across chunks", () => {
    const chunks: string[] = [];
    const redactor = createLineRedactor({ write: (chunk: string) => chunks.push(chunk) });
    redactor.push(`first ${key.slice(0, 20)}`);
    redactor.push(Buffer.from(`${key.slice(20)} tail\nsecond`));
    redactor.flush();
    const output = chunks.join("");
    expect(output).toBe("first agnts_3f9a… tail\nsecond");
    expect(output).not.toContain(key);
  });
});

describe("JSON-safe redaction", () => {
  it("text with a header name and an escaped quote serializes to valid JSON", () => {
    for (const name of ["Authorization", "X-API-Key", "Idempotency-Key", "authorization"]) {
      for (const sep of [": ", "=", ":", '":"']) {
        const doc = { data: { text: `send ${name}${sep}abc"def\\ghi" now`, list: [`${name}: a"b`] } };
        const text = serializeRedacted(doc);
        expect(() => JSON.parse(text), `${name}${sep}`).not.toThrow();
        expect(JSON.parse(text).data.text).not.toContain("abc");
      }
    }
    expect(JSON.parse(serializeRedacted({ list: ["Authorization:"], obj: { Authorization: { nested: 1 } } }))).toEqual({
      list: ["Authorization:"],
      obj: { Authorization: REDACTED },
    });
  });

  it("the plain-text header rule never consumes a backslash", () => {
    expect(redact('Authorization: abc\\"def')).toBe(`Authorization: ${REDACTED}\\"def`);
  });

  it("keys in property names are redacted too", () => {
    expect(serializeRedacted({ [key]: 1 })).toBe('{"agnts_3f9a…":1}');
  });
});

describe("line redactor buffer cap", () => {
  it("never splits a key across a forced flush", () => {
    for (const offset of [65_520, 65_530, 65_536, 65_540]) {
      const chunks: string[] = [];
      const redactor = createLineRedactor({ write: (chunk: string) => chunks.push(chunk) });
      const input = `${"x ".repeat(offset / 2)}${key}${" z".repeat(100)}`;
      for (let index = 0; index < input.length; index += 4096) redactor.push(input.slice(index, index + 4096));
      redactor.push("\n");
      redactor.flush();
      const output = chunks.join("");
      expect(output, String(offset)).not.toContain(key);
      expect(output).not.toContain(key.slice(10));
    }
  });

  it("keeps an open credential header together across a forced flush", () => {
    const chunks: string[] = [];
    const redactor = createLineRedactor({ write: (chunk: string) => chunks.push(chunk) }, 64);
    redactor.push(`${"y ".repeat(40)}Authorization: Bearer `);
    redactor.push("opaque-token-value, done");
    redactor.flush();
    const output = chunks.join("");
    expect(output).not.toContain("opaque-token-value");
  });

  it("flushes a safe prefix and holds the trailing token", () => {
    expect(safeFlushPoint("hello world agnts_12")).toBe("hello world ".length);
    expect(safeFlushPoint("hello X-API-Key: abc")).toBe("hello ".length);
    expect(safeFlushPoint("done, ")).toBe("done, ".length);
    expect(safeFlushPoint("aaaaaaaa")).toBe(0);
  });

  it("bounds memory for one endless token without emitting a whole key", () => {
    const chunks: string[] = [];
    const redactor = createLineRedactor({ write: (chunk: string) => chunks.push(chunk) }, 1024);
    redactor.push("x".repeat(16 * 1024 + 10));
    expect(chunks.join("").length).toBeGreaterThan(0);
    redactor.push(`${key}tail`);
    redactor.flush();
    expect(chunks.join("")).not.toContain(key);
  });
});
