/**
 * Grant envelope, CLI side (plan §2.7 and §8 "Envelope"): the shared vector
 * (`test/fixtures/grant-envelope-v1.json`, a byte copy of the portal's
 * `developers/src/cli/__fixtures__/grant-envelope-v1.json`; CI `cmp`s them)
 * decrypts, and a payload encrypted by the PORTAL's own `envelope.ts`
 * decrypts here, so the two sides cannot drift.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GRANT_ENVELOPE_ALG,
  GrantEnvelopeError,
  base64UrlEncode,
  decryptGrantEnvelope,
  generateGrantKeyPair,
  grantInfo,
  jwkThumbprint,
  parseGrantEnvelope,
  parsePrivateJwk,
  publicOf,
  type GrantEnvelope,
  type P256PrivateJwk,
} from "../src/core/envelope.js";
import { redactValue } from "../src/core/redact.js";
// The portal's encrypting side, imported as source: the end-to-end check below uses it directly.
import { encryptGrantPayload } from "../../developers/src/cli/envelope.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = path.join(HERE, "fixtures", "grant-envelope-v1.json");
const PORTAL_FIXTURE_FILE = path.resolve(HERE, "../../developers/src/cli/__fixtures__/grant-envelope-v1.json");

interface Vector {
  normalizedUserCode: string;
  cliPrivateKeyJwk: P256PrivateJwk;
  cliPublicKeyJwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
  cliKeyThumbprint: string;
  info: string;
  payload: Record<string, unknown>;
  payloadJson: string;
  envelope: GrantEnvelope;
}

const vector = JSON.parse(readFileSync(FIXTURE_FILE, "utf8")) as Vector;

describe("shared test vector", () => {
  it("is a byte copy of the portal's vector", () => {
    expect(readFileSync(FIXTURE_FILE)).toEqual(readFileSync(PORTAL_FIXTURE_FILE));
  });

  it("decrypts with the CLI private key to the exact payload JSON", async () => {
    const text = await decryptGrantEnvelope(vector.envelope, { privateKey: vector.cliPrivateKeyJwk, normalizedUserCode: vector.normalizedUserCode });
    expect(text).toBe(vector.payloadJson);
    expect(JSON.parse(text)).toEqual(vector.payload);
  });

  it("computes the RFC 7638 thumbprint and the HKDF info of the vector", () => {
    expect(jwkThumbprint(vector.cliPublicKeyJwk)).toBe(vector.cliKeyThumbprint);
    expect(new TextDecoder().decode(grantInfo(vector.normalizedUserCode, vector.cliKeyThumbprint))).toBe(vector.info);
    expect(publicOf(vector.cliPrivateKeyJwk)).toEqual(vector.cliPublicKeyJwk);
  });

  it("refuses another user code, another key, and tampered ciphertext", async () => {
    await expect(
      decryptGrantEnvelope(vector.envelope, { privateKey: vector.cliPrivateKeyJwk, normalizedUserCode: "BCDFGHJK" }),
    ).rejects.toBeInstanceOf(GrantEnvelopeError);
    const other = await generateGrantKeyPair();
    await expect(
      decryptGrantEnvelope(vector.envelope, { privateKey: other.privateKey, normalizedUserCode: vector.normalizedUserCode }),
    ).rejects.toThrow(/does not decrypt/);
    const ct = Buffer.from(vector.envelope.ct, "base64url");
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    await expect(
      decryptGrantEnvelope({ ...vector.envelope, ct: ct.toString("base64url") }, { privateKey: vector.cliPrivateKeyJwk, normalizedUserCode: vector.normalizedUserCode }),
    ).rejects.toThrow(/does not decrypt/);
    await expect(
      decryptGrantEnvelope(vector.envelope, { privateKey: vector.cliPrivateKeyJwk, normalizedUserCode: "wdjbmjht" }),
    ).rejects.toThrow(/not normalized/);
  });
});

describe("envelope shape", () => {
  it("rejects anything that is not a v1 envelope", () => {
    const good = vector.envelope;
    expect(parseGrantEnvelope(good)).toEqual(good);
    const cases: unknown[] = [
      null,
      [],
      { ...good, v: 2 },
      { ...good, alg: "A256GCM" },
      { ...good, epk: { ...good.epk, crv: "P-384" } },
      { ...good, epk: { kty: "EC", crv: "P-256", x: "short", y: good.epk.y } },
      { ...good, salt: base64UrlEncode(new Uint8Array(15)) },
      { ...good, iv: base64UrlEncode(new Uint8Array(16)) },
      { ...good, ct: "" },
      { ...good, ct: "a".repeat(12 * 1024 + 4) },
      { ...good, ct: `${good.ct.slice(0, -1)}+` },
    ];
    for (const value of cases) expect(() => parseGrantEnvelope(value), JSON.stringify(value)?.slice(0, 80)).toThrow(GrantEnvelopeError);
  });
});

describe("key pair", () => {
  it("generates an exportable P-256 pair; the public half has no d and the redactor drops d", async () => {
    const pair = await generateGrantKeyPair();
    expect(pair.publicKey).toEqual({ kty: "EC", crv: "P-256", x: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), y: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(Object.keys(pair.publicKey).sort()).toEqual(["crv", "kty", "x", "y"]);
    expect(parsePrivateJwk(pair.privateKey)).toEqual(pair.privateKey);
    expect(pair.privateKey.d).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(jwkThumbprint(pair.publicKey)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(redactValue({ jwk: pair.privateKey }))).not.toContain(pair.privateKey.d);
  });
});

describe("end to end with the portal's envelope.ts", () => {
  it("a payload the portal encrypts to a fresh CLI key decrypts here, bound to the code", async () => {
    const pair = await generateGrantKeyPair();
    const payload = { ...vector.payload, userCode: "WDJBMJHT", warnings: ["from the portal implementation"] };
    const envelope = (await encryptGrantPayload(payload, { publicKey: pair.publicKey, normalizedUserCode: "WDJBMJHT" })) as GrantEnvelope;
    expect(envelope.alg).toBe(GRANT_ENVELOPE_ALG);
    expect(parseGrantEnvelope(envelope)).toEqual(envelope);
    const text = await decryptGrantEnvelope(envelope, { privateKey: pair.privateKey, normalizedUserCode: "WDJBMJHT" });
    expect(JSON.parse(text)).toEqual(payload);
    await expect(decryptGrantEnvelope(envelope, { privateKey: pair.privateKey, normalizedUserCode: "BCDFGHJK" })).rejects.toBeInstanceOf(GrantEnvelopeError);
  });

  it("the portal's fixed-vector encryption reproduces the shared vector byte for byte", async () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_FILE, "utf8")) as Vector & { ephemeralPrivateKeyJwk: P256PrivateJwk; salt: string; iv: string };
    const envelope = await encryptGrantPayload(fixture.payload, {
      publicKey: fixture.cliPublicKeyJwk,
      normalizedUserCode: fixture.normalizedUserCode,
      ephemeralPrivateKey: fixture.ephemeralPrivateKeyJwk,
      salt: Buffer.from(fixture.salt, "base64url"),
      iv: Buffer.from(fixture.iv, "base64url"),
    });
    expect(envelope).toEqual(fixture.envelope);
  });
});
