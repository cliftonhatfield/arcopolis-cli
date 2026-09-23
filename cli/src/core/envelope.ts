/**
 * Grant envelope, CLI side (plan §2.7). The approval page encrypts the
 * provisioning payload to the P-256 public key this CLI generated, so only
 * the terminal that started the grant can read it; the server relays
 * ciphertext only. This module generates that key pair and decrypts:
 *
 *   ECDH(P-256, CLI private, page ephemeral public `epk`) -> 256 bits
 *   HKDF-SHA256(bits, salt = 16 bytes, info) -> AES-256-GCM key
 *   AES-GCM(iv = 12 bytes, additionalData = info) over the UTF-8 JSON payload
 *   info = utf8("arcopolis-cli-grant-v1|" + normalizedUserCode + "|" + cliKeyThumbprint)
 *
 * Node 22's WebCrypto (the same implementation as `globalThis.crypto`) does
 * all the cryptography. The CLI never encrypts. The private JWK exists only
 * in memory and in `pending-grant.json` (0600); it is never logged, printed,
 * or returned by a tool (the redactor also drops any JWK `d`).
 *
 * The portal's encrypting twin is `developers/src/cli/envelope.ts`; the shared
 * vector `test/fixtures/grant-envelope-v1.json` pins both sides.
 */
import { createHash, webcrypto } from "node:crypto";

export const GRANT_ENVELOPE_VERSION = 1;
export const GRANT_ENVELOPE_ALG = "ECDH-ES+HKDF-SHA256+A256GCM";
export const GRANT_INFO_PREFIX = "arcopolis-cli-grant-v1|";
/** Largest plaintext payload, in UTF-8 bytes. */
export const MAX_GRANT_PAYLOAD_BYTES = 8 * 1024;
/** Largest ciphertext the server accepts, in base64url characters. */
export const MAX_GRANT_CIPHERTEXT_CHARS = 12 * 1024;

const SALT_BYTES = 16;
const IV_BYTES = 12;
/** AES-GCM tag (16 bytes) plus at least one byte of payload. */
const MIN_CIPHERTEXT_BYTES = 17;
const B64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;
const B64URL = /^[A-Za-z0-9_-]*$/;
const NORMALIZED_USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/;

const subtle = webcrypto.subtle;

/** Public P-256 JWK exactly as it travels: no `d`, no `key_ops`, no `ext`. */
export interface P256PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

/** Private P-256 JWK. Held only in memory and in `pending-grant.json` (0600). */
export interface P256PrivateJwk extends P256PublicJwk {
  d: string;
}

/** The v1 envelope the page stores through `complete` and `poll` returns while approved. */
export interface GrantEnvelope {
  v: 1;
  alg: typeof GRANT_ENVELOPE_ALG;
  epk: P256PublicJwk;
  salt: string;
  iv: string;
  ct: string;
}

/**
 * A key, envelope, or ciphertext that does not meet §2.7. The message names
 * what failed and never carries key material.
 */
export class GrantEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantEnvelopeError";
  }
}

/** Base64url without padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

/** Strict base64url decode (no padding, no other alphabet). */
export function base64UrlDecode(text: string, label = "value"): Buffer {
  if (!B64URL.test(text) || text.length % 4 === 1) throw new GrantEnvelopeError(`${label} is not base64url.`);
  return Buffer.from(text, "base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A well-formed public P-256 JWK with only `kty`, `crv`, `x`, `y`, or null. */
export function parsePublicJwk(value: unknown): P256PublicJwk | null {
  if (!isRecord(value)) return null;
  const { kty, crv, x, y } = value;
  if (kty !== "EC" || crv !== "P-256") return null;
  if (typeof x !== "string" || !B64URL_32_BYTES.test(x) || typeof y !== "string" || !B64URL_32_BYTES.test(y)) return null;
  return { kty, crv, x, y };
}

/** A well-formed private P-256 JWK (`kty`, `crv`, `x`, `y`, `d`), or null. */
export function parsePrivateJwk(value: unknown): P256PrivateJwk | null {
  const pub = parsePublicJwk(value);
  if (!pub || !isRecord(value) || typeof value.d !== "string" || !B64URL_32_BYTES.test(value.d)) return null;
  return { ...pub, d: value.d };
}

/** The public half of a private JWK. */
export function publicOf(jwk: P256PrivateJwk): P256PublicJwk {
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

/**
 * RFC 7638 JWK thumbprint: SHA-256 over the required members (`crv`, `kty`,
 * `x`, `y`) in lexicographic order with no whitespace, base64url encoded.
 */
export function jwkThumbprint(jwk: P256PublicJwk): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

/** HKDF info and AES-GCM additional data for one grant. */
export function grantInfo(normalizedUserCode: string, cliKeyThumbprint: string): Uint8Array {
  return new TextEncoder().encode(`${GRANT_INFO_PREFIX}${normalizedUserCode}|${cliKeyThumbprint}`);
}

/**
 * A fresh ECDH P-256 key pair as JWKs. The private JWK must be written only to
 * `pending-grant.json` (0600).
 */
export async function generateGrantKeyPair(): Promise<{ publicKey: P256PublicJwk; privateKey: P256PrivateJwk }> {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const privateKey = parsePrivateJwk(await subtle.exportKey("jwk", pair.privateKey));
  const publicKey = parsePublicJwk(await subtle.exportKey("jwk", pair.publicKey));
  if (!privateKey || !publicKey || privateKey.x !== publicKey.x || privateKey.y !== publicKey.y) {
    throw new GrantEnvelopeError("Could not export the generated P-256 key pair.");
  }
  return { publicKey, privateKey };
}

/** Validates a v1 envelope's shape and sizes (the server checks the same). */
export function parseGrantEnvelope(value: unknown): GrantEnvelope {
  if (!isRecord(value)) throw new GrantEnvelopeError("The envelope is not an object.");
  if (value.v !== GRANT_ENVELOPE_VERSION) throw new GrantEnvelopeError("Unsupported envelope version.");
  if (value.alg !== GRANT_ENVELOPE_ALG) throw new GrantEnvelopeError("Unsupported envelope algorithm.");
  const epk = parsePublicJwk(value.epk);
  if (!epk) throw new GrantEnvelopeError("The envelope epk is not a P-256 public key.");
  const { salt, iv, ct } = value;
  if (typeof salt !== "string" || base64UrlDecode(salt, "salt").length !== SALT_BYTES) {
    throw new GrantEnvelopeError("The envelope salt is not 16 bytes of base64url.");
  }
  if (typeof iv !== "string" || base64UrlDecode(iv, "iv").length !== IV_BYTES) {
    throw new GrantEnvelopeError("The envelope iv is not 12 bytes of base64url.");
  }
  if (typeof ct !== "string" || ct.length > MAX_GRANT_CIPHERTEXT_CHARS || base64UrlDecode(ct, "ct").length < MIN_CIPHERTEXT_BYTES) {
    throw new GrantEnvelopeError("The envelope ciphertext is missing, too short, or too long.");
  }
  return { v: GRANT_ENVELOPE_VERSION, alg: GRANT_ENVELOPE_ALG, epk, salt, iv, ct };
}

async function importPrivateKey(jwk: P256PrivateJwk): Promise<webcrypto.CryptoKey> {
  try {
    return await subtle.importKey("jwk", { ...jwk, ext: false }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  } catch {
    throw new GrantEnvelopeError("The saved private key is not a valid P-256 key.");
  }
}

async function importPublicKey(jwk: P256PublicJwk): Promise<webcrypto.CryptoKey> {
  try {
    return await subtle.importKey("jwk", { ...jwk, ext: true }, { name: "ECDH", namedCurve: "P-256" }, true, []);
  } catch {
    throw new GrantEnvelopeError("The envelope epk is not a point on P-256.");
  }
}

/**
 * Decrypts an envelope with the CLI private key and returns the UTF-8 JSON
 * text (at most 8 KB). The user code and the thumbprint of this key are
 * bound in as HKDF info and AES-GCM additional data, so an envelope made for
 * another code or another key never decrypts.
 */
export async function decryptGrantEnvelope(
  envelope: unknown,
  options: { privateKey: P256PrivateJwk; normalizedUserCode: string },
): Promise<string> {
  const parsed = parseGrantEnvelope(envelope);
  const privateJwk = parsePrivateJwk(options.privateKey);
  if (!privateJwk) throw new GrantEnvelopeError("The saved private key is not a P-256 JWK.");
  if (!NORMALIZED_USER_CODE.test(options.normalizedUserCode)) throw new GrantEnvelopeError("The user code is not normalized.");
  const info = grantInfo(options.normalizedUserCode, jwkThumbprint(publicOf(privateJwk)));
  const privateKey = await importPrivateKey(privateJwk);
  const peer = await importPublicKey(parsed.epk);
  let plaintext: ArrayBuffer;
  try {
    const shared = await subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
    const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const aesKey = await subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: base64UrlDecode(parsed.salt, "salt"), info },
      hkdf,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    plaintext = await subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlDecode(parsed.iv, "iv"), additionalData: info },
      aesKey,
      base64UrlDecode(parsed.ct, "ct"),
    );
  } catch {
    throw new GrantEnvelopeError("The envelope does not decrypt with this terminal's key and code.");
  }
  if (plaintext.byteLength > MAX_GRANT_PAYLOAD_BYTES) throw new GrantEnvelopeError("The decrypted payload is larger than 8 KB.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new GrantEnvelopeError("The decrypted payload is not UTF-8.");
  }
}
