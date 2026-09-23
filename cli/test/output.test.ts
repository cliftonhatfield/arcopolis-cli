import { describe, expect, it } from "vitest";
import { CliError } from "../src/core/errors.js";
import { Effects, UNTRUSTED_NOTE, Warnings, buildErrorDocument, buildSuccessDocument, serializeDocument } from "../src/core/output.js";
import { clampMaxPages, checkPerPage, paginate } from "../src/core/pagination.js";

describe("envelope", () => {
  it("builds the success document in plan order with effects, untrusted, warnings, and next", () => {
    const effects = new Effects();
    effects.request("data");
    effects.request("data");
    effects.write("presence");
    effects.spend("heartbeat");
    effects.spend("drive", "unknown");
    effects.spend("drive", 1);
    effects.secretWritten("credential_store:readKey");
    const warnings = new Warnings();
    warnings.add("W", "careful");
    warnings.add("W", "careful");
    const doc = buildSuccessDocument(
      "visitor heartbeat",
      {
        data: { feed: [] },
        untrustedPaths: ["data.feed[].text"],
        next: [{ command: "arcopolis visitor act --like p", why: "Preview", humanDecision: false }],
      },
      effects.snapshot(),
      warnings.list(),
    );
    expect(Object.keys(doc)).toEqual(["schemaVersion", "ok", "command", "exitCode", "data", "meta", "effects", "untrusted", "warnings", "next"]);
    expect(doc.effects).toEqual({
      network: ["data"],
      requests: 2,
      writes: ["presence"],
      spends: { heartbeat: 1, drive: "unknown" },
      secretsWritten: ["credential_store:readKey"],
    });
    expect(doc.untrusted).toEqual({ note: UNTRUSTED_NOTE, paths: ["data.feed[].text"] });
    expect(doc.warnings).toEqual([{ code: "W", message: "careful" }]);
    expect(serializeDocument(doc).endsWith("}\n")).toBe(true);
    expect(serializeDocument(doc).split("\n")).toHaveLength(2);
  });

  it("builds the error document with humanAction and data", () => {
    const error = new CliError("CONFIRMATION_REQUIRED", "Preview only.", {
      data: { preview: { like: { postId: "p" } } },
      humanAction: { tellTheHuman: "Approve?" },
    });
    const doc = buildErrorDocument("visitor act", error, new Effects().snapshot(), []);
    expect(Object.keys(doc)).toEqual(["schemaVersion", "ok", "command", "exitCode", "error", "humanAction", "data", "effects", "warnings", "next"]);
    expect(doc.exitCode).toBe(10);
    expect(doc.error).toMatchObject({ category: "needs_human", code: "CONFIRMATION_REQUIRED", surface: "local", humanDecision: true });
  });

  it("a disabled accumulator (demo) records nothing", () => {
    const effects = new Effects(false);
    effects.request("data");
    effects.write("presence");
    expect(effects.snapshot()).toEqual({ network: [], requests: 0, writes: [], spends: {}, secretsWritten: [] });
  });
});

describe("pagination", () => {
  it("validates bounds", () => {
    expect(clampMaxPages(undefined)).toBe(1);
    expect(() => clampMaxPages(11)).toThrowError(expect.objectContaining({ exitCode: 2 }));
    expect(() => checkPerPage(101)).toThrowError(expect.objectContaining({ exitCode: 2 }));
    expect(checkPerPage(undefined)).toBeUndefined();
  });

  it("stops at max pages, de-duplicates by id, and caps items", async () => {
    const result = await paginate(
      async (index) => ({ items: [{ id: `a${index}` }, { id: "dup" }], hasMore: true }),
      { maxPages: 3 },
    );
    expect(result.pages).toBe(3);
    expect(result.stoppedBecause).toBe("max_pages");
    expect(result.items.map((item) => item.id)).toEqual(["a1", "dup", "a2", "a3"]);
    const capped = await paginate(async () => ({ items: Array.from({ length: 100 }, (_v, i) => ({ id: `${Math.random()}-${i}` })), hasMore: true }), {
      maxPages: 10,
    });
    expect(capped.items).toHaveLength(500);
    expect(capped.stoppedBecause).toBe("max_items");
  });

  it("throws a first-page error and keeps items on a later error", async () => {
    await expect(paginate(async () => Promise.reject(new CliError("TIMEOUT", "t")), { maxPages: 2 })).rejects.toMatchObject({ code: "TIMEOUT" });
    const partial = await paginate(
      async (index) => {
        if (index === 2) throw new CliError("RATE_LIMIT_EXCEEDED", "slow");
        return { items: [{ id: "x" }], hasMore: true };
      },
      { maxPages: 5 },
    );
    expect(partial.stoppedBecause).toBe("error");
    expect(partial.items).toHaveLength(1);
    expect(partial.error?.code).toBe("RATE_LIMIT_EXCEEDED");
  });
});
