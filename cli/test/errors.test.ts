import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CliError,
  EXIT_CODES,
  categoryForCode,
  categoryForStatus,
  defaultRetry,
  exitCodeTable,
  fromApiError,
  isKnownCode,
  lookupCodeCategory,
  nextUtcMidnight,
} from "../src/core/errors.js";

/** Plan §3.2, row by row: every listed code and the exit it must produce. */
const PLAN_TABLE: Record<number, string[]> = {
  1: ["GRANT_PAYLOAD_INVALID", "INTERNAL", "NOT_IMPLEMENTED"],
  2: [
    "SECRET_IN_ARGUMENTS",
    "PATH_NOT_IN_OPENAPI",
    "INVALID_INPUT",
    "INVALID_QUERY",
    "INVALID_ACTION",
    "IDEMPOTENCY_KEY_REQUIRED",
    "PAYLOAD_TOO_LARGE",
    "INPUT_MODERATION_BLOCKED",
    "INVALID_JOURNAL_QUERY",
    "JOURNAL_CURSOR_SCOPE_MISMATCH",
    "INVALID_STANDING_QUERY",
    "INVALID_OBSERVE_QUERY",
    "INVALID_OBSERVE_CURSOR",
    "CLI_GRANT_CODE_MATCH_REQUIRED",
    "USAGE_ERROR",
    "UNKNOWN_COMMAND",
    "UNKNOWN_FLAG",
  ],
  3: ["MISSING_API_KEY", "INVALID_API_KEY", "KEY_REVOKED", "KEY_DISABLED", "APP_DISABLED", "UNAUTHORIZED", "NO_CREDENTIALS"],
  4: [
    "INSUFFICIENT_TIER",
    "INSUFFICIENT_SCOPE",
    "DRIVE_BINDING_INVALID",
    "DRIVE_WORLD_MISMATCH",
    "DRIVE_AGENT_NOT_ALLOWED",
    "DRIVE_AGENT_NOT_VISITOR",
    "DRIVE_AGENT_DISABLED",
    "AGENT_NOT_ALLOWED",
    "STANDING_ACCESS_DENIED",
    "OBSERVE_ACCESS_DENIED",
    "ACCOUNT_PENDING",
    "ACCOUNT_DISABLED",
    "CLI_GRANTS_NOT_ALLOWED",
    "CLI_GRANT_ACCOUNT_MISMATCH",
    "APPROVER_MISMATCH",
    "WRITES_DISABLED",
  ],
  5: ["NOT_FOUND", "WORLD_NOT_FOUND", "CLI_GRANT_NOT_FOUND", "GRANT_NOT_STARTED"],
  6: ["RATE_LIMIT_EXCEEDED", "OBSERVE_RATE_LIMITED", "SLOW_DOWN", "CLI_GRANT_RATE_LIMITED", "LOCAL_RATE_LIMIT", "LOCAL_CADENCE_GUARD"],
  7: [
    "DRIVE_DAILY_BUDGET_EXCEEDED",
    "HEARTBEAT_DAILY_BUDGET_EXCEEDED",
    "JOURNAL_DAILY_BUDGET_EXCEEDED",
    "STANDING_DAILY_BUDGET_EXCEEDED",
    "INVOKE_DAILY_BUDGET_EXCEEDED",
    "OBSERVE_DAILY_BUDGET_EXCEEDED",
    "ACTION_BUDGET_EMPTY",
  ],
  8: [
    "VISITOR_DRIVE_DISABLED",
    "VISITOR_JOURNAL_DISABLED",
    "VISITOR_STANDING_DISABLED",
    "VISITOR_OBSERVE_DISABLED",
    "AGENT_INVOKE_DISABLED",
    "DEVELOPER_PORTAL_DISABLED",
    "CLI_GRANTS_DISABLED",
    "VISITOR_SELF_SERVE_DISABLED",
    "VISITORS_PAUSED",
    "DEVELOPER_SIGNUPS_DISABLED",
    "NO_VISITOR_WORLD_OPEN",
    "ACTION_CLOSED",
  ],
  9: ["VISITOR_ACTION_OUTCOME_UNRESOLVED", "WRITE_TIMEOUT", "WRITE_NETWORK_ERROR", "INVALID_ACTION_RESPONSE", "PENDING_TOO_OLD"],
  10: ["APPROVAL_PENDING", "APPROVAL_DENIED", "CONFIRMATION_REQUIRED", "HUMAN_SETUP_REQUIRED"],
  11: ["EDGE_BLOCKED", "NON_JSON_RESPONSE", "REDIRECT_REJECTED"],
  12: [
    "INTERNAL_ERROR",
    "JOURNAL_READ_FAILED",
    "STANDING_READ_FAILED",
    "STANDING_BUILD_UNAVAILABLE",
    "DRIVE_BUDGET_CHECK_FAILED",
    "LLM_REQUEST_FAILED",
    "LLM_TEMPORARILY_UNAVAILABLE",
    "TIMEOUT",
    "NETWORK_ERROR",
  ],
  13: [
    "CLI_GRANT_NOT_PENDING",
    "CLI_GRANT_EXPIRED",
    "CLI_GRANT_REQUEST_CHANGED",
    "VISITOR_LIMIT_REACHED",
    "VISITOR_REGISTRATION_REFUSED",
    "STATE_LOCKED",
    "PENDING_ACTION_MISMATCH",
  ],
};

const fixture = JSON.parse(readFileSync(new URL("./fixtures/openapi-codes.json", import.meta.url), "utf8")) as {
  openapi: string[];
  developerApi: string[];
};

describe("error code table", () => {
  for (const [exit, codes] of Object.entries(PLAN_TABLE)) {
    it(`maps every plan code to exit ${exit}`, () => {
      for (const code of codes) {
        expect(new CliError(code, "x").exitCode, code).toBe(Number(exit));
      }
    });
  }

  it("IDEMPOTENCY_IN_PROGRESS is exit 9 on a write and 13 on a read", () => {
    expect(new CliError("IDEMPOTENCY_IN_PROGRESS", "x", { write: true, httpStatus: 409 }).exitCode).toBe(9);
    expect(new CliError("IDEMPOTENCY_IN_PROGRESS", "x", { httpStatus: 409 }).exitCode).toBe(13);
  });

  it("every error code in the OpenAPI fixture maps to a known category", () => {
    expect(fixture.openapi.length).toBeGreaterThan(40);
    for (const code of fixture.openapi) {
      expect(isKnownCode(code) || code === "IDEMPOTENCY_IN_PROGRESS", code).toBe(true);
    }
  });

  it("the fixture lists every code in the bundled OpenAPI snapshot", () => {
    const snapshot = readFileSync(new URL("../src/generated/openapi.json", import.meta.url), "utf8");
    const derived = [...new Set(snapshot.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])].sort();
    expect(derived).toEqual([...fixture.openapi].sort());
  });

  it("every developerApi and grant code maps to a known category", () => {
    for (const code of fixture.developerApi) expect(isKnownCode(code), code).toBe(true);
  });

  it("unknown codes fall back by HTTP status", () => {
    const cases: Array<[number, number, boolean?]> = [
      [400, 2],
      [401, 3],
      [403, 4],
      [404, 5],
      [409, 13],
      [409, 9, true],
      [429, 6],
      [500, 12],
      [502, 12],
      [503, 12],
    ];
    for (const [status, exit, write] of cases) {
      expect(new CliError("SOMETHING_NEW", "x", { httpStatus: status, write }).exitCode, `${status}`).toBe(exit);
    }
    expect(categoryForStatus(undefined)).toBe("internal");
    expect(lookupCodeCategory("SOMETHING_NEW")).toBeUndefined();
  });

  it("known codes win over the status fallback", () => {
    expect(categoryForCode("INVOKE_DAILY_BUDGET_EXCEEDED", { httpStatus: 429 })).toBe("budget_exhausted");
    expect(categoryForCode("DEVELOPER_PORTAL_DISABLED", { httpStatus: 503 })).toBe("unavailable");
  });

  it("an explicit category overrides the table", () => {
    expect(new CliError("NEW_LOCAL_CODE", "x", { category: "not_found" }).exitCode).toBe(5);
  });

  it("publishes one row per exit code", () => {
    const rows = exitCodeTable();
    expect(rows.map((row) => row.exit)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(Object.keys(EXIT_CODES)).toHaveLength(14);
  });
});

describe("fromApiError", () => {
  it("passes reasonCode, candidates, and invocationId through details", () => {
    const error = fromApiError({
      httpStatus: 409,
      code: "VISITOR_REGISTRATION_REFUSED",
      message: "Refused",
      extra: { reasonCode: "handle_taken", invocationId: "inv_1" },
      surface: "control",
    });
    expect(error.code).toBe("VISITOR_REGISTRATION_REFUSED");
    expect(error.exitCode).toBe(13);
    expect(error.details).toEqual({ reasonCode: "handle_taken", candidates: null, invocationId: "inv_1" });
    expect(error.surface).toBe("control");
  });

  it("re-codes VISITOR_WORLD_REQUIRED with empty candidates as NO_VISITOR_WORLD_OPEN (exit 8)", () => {
    const empty = fromApiError({ httpStatus: 409, code: "VISITOR_WORLD_REQUIRED", extra: { candidates: [] }, surface: "control" });
    expect(empty.code).toBe("NO_VISITOR_WORLD_OPEN");
    expect(empty.exitCode).toBe(8);
    const some = fromApiError({
      httpStatus: 409,
      code: "VISITOR_WORLD_REQUIRED",
      extra: { candidates: [{ id: "world_7" }] },
      surface: "control",
    });
    expect(some.code).toBe("VISITOR_WORLD_REQUIRED");
  });

  it("uses HTTP_<status> when the body has no code", () => {
    const error = fromApiError({ httpStatus: 502, surface: "data" });
    expect(error.code).toBe("HTTP_502");
    expect(error.exitCode).toBe(12);
  });
});

describe("retry advice", () => {
  it("after_utc_reset points at the next UTC midnight", () => {
    const now = new Date("2026-09-22T23:30:00.000Z");
    expect(nextUtcMidnight(now)).toBe("2026-09-23T00:00:00.000Z");
    expect(nextUtcMidnight(new Date("2026-12-31T00:00:00.000Z"))).toBe("2027-01-01T00:00:00.000Z");
    const error = new CliError("DRIVE_DAILY_BUDGET_EXCEEDED", "x", { httpStatus: 429, now });
    expect(error.retry).toEqual({ strategy: "after_utc_reset", resetsAt: "2026-09-23T00:00:00.000Z" });
  });

  it("rate limits use Retry-After seconds when present", () => {
    expect(defaultRetry("rate_limited", { retryAfterSeconds: 12 })).toEqual({ strategy: "after_seconds", afterSeconds: 12 });
    expect(defaultRetry("rate_limited")).toEqual({ strategy: "later" });
    expect(defaultRetry("unresolved_write")).toEqual({ strategy: "same_request_only" });
    expect(defaultRetry("needs_human")).toEqual({ strategy: "after_human" });
  });

  it("humanDecision defaults follow the category", () => {
    expect(new CliError("VISITOR_ACTION_OUTCOME_UNRESOLVED", "x").humanDecision).toBe(true);
    expect(new CliError("RATE_LIMIT_EXCEEDED", "x").humanDecision).toBe(false);
  });
});
