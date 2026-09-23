import { describe, expect, it } from "vitest";
import { checkBase, classifyBase, joinUrl, normalizeBase, resolveApiBase, resolveDeveloperBase, stripV1 } from "../src/core/bases.js";

describe("normalizeBase (starter port)", () => {
  it("accepts HTTPS and loopback HTTP, trims trailing slashes", () => {
    expect(normalizeBase("https://api.arcopolis.ai/v1/")).toBe("https://api.arcopolis.ai/v1");
    expect(normalizeBase("http://localhost:5001/v1")).toBe("http://localhost:5001/v1");
    expect(normalizeBase("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1");
    expect(normalizeBase("http://[::1]:8080/v1")).toBe("http://[::1]:8080/v1");
  });

  it.each(["http://api.arcopolis.ai/v1", "https://u:p@api.arcopolis.ai/v1", "https://api.arcopolis.ai/v1?x=1", "https://api.arcopolis.ai/v1#f", "not a url"])(
    "rejects %s with INVALID_BASE (exit 2)",
    (value) => {
      expect(() => normalizeBase(value)).toThrowError(expect.objectContaining({ code: "INVALID_BASE", exitCode: 2 }));
    },
  );
});

describe("host policy", () => {
  it("classifies canonical, loopback, and custom hosts per plane", () => {
    expect(classifyBase("https://api.arcopolis.ai/v1", "data")).toBe("canonical");
    expect(classifyBase("https://developers.arcologylabs.com/_developer", "control")).toBe("canonical");
    expect(classifyBase("https://developers.arcologylabs.com/_developer", "data")).toBe("custom");
    expect(classifyBase("http://localhost:1/v1", "data")).toBe("loopback");
  });

  it("custom hosts need ARCOPOLIS_ALLOW_CUSTOM_BASE=1", () => {
    expect(() => checkBase("https://staging.example.com/v1", "data", "env", {})).toThrowError(
      expect.objectContaining({ code: "CUSTOM_BASE_NOT_ALLOWED", exitCode: 2 }),
    );
    expect(checkBase("https://staging.example.com/v1", "data", "env", { ARCOPOLIS_ALLOW_CUSTOM_BASE: "1" }).kind).toBe("custom");
  });

  it("resolves env, legacy env (with a warning), and defaults", () => {
    const warnings: string[] = [];
    expect(resolveApiBase({}).url).toBe("https://api.arcopolis.ai/v1");
    expect(resolveApiBase({ ARCOPOLIS_API_BASE: "http://localhost:5001/v1" }).source).toBe("env");
    const legacy = resolveApiBase({ AGNTS_API_BASE_URL: "https://api.arcopolis.ai/v1" }, (code) => warnings.push(code));
    expect(legacy.source).toBe("legacy_env");
    expect(warnings).toEqual(["DEPRECATED_ENV"]);
    expect(resolveDeveloperBase({}).url).toBe("https://developers.arcologylabs.com/_developer");
  });
});

describe("paths", () => {
  it("strips one leading /v1 so it is never doubled", () => {
    expect(stripV1("/v1/agents")).toBe("/agents");
    expect(stripV1("/v1")).toBe("/");
    expect(stripV1("/v1?x=1")).toBe("/?x=1");
    expect(stripV1("/v10/agents")).toBe("/v10/agents");
    expect(stripV1("agents")).toBe("/agents");
    expect(stripV1("/agents")).toBe("/agents");
  });

  it("joins only single-slash relative paths", () => {
    expect(joinUrl("https://api.arcopolis.ai/v1", "/agents")).toBe("https://api.arcopolis.ai/v1/agents");
    expect(joinUrl("https://api.arcopolis.ai/v1", "/")).toBe("https://api.arcopolis.ai/v1");
    expect(() => joinUrl("https://api.arcopolis.ai/v1", "//evil.example")).toThrow();
    expect(() => joinUrl("https://api.arcopolis.ai/v1", "https://evil.example")).toThrow();
  });
});
