/**
 * Grant envelope encryption (plan §2.7). The page encrypts the provisioning
 * payload to the CLI's P-256 public key so only the terminal that started the
 * grant can read it; the server stores ciphertext only.
 *
 *   ECDH(P-256, ephemeral private, CLI public) -> 256 bits
 *   HKDF-SHA256(bits, salt = 16 random bytes, info) -> AES-256-GCM key
 *   AES-GCM(iv = 12 random bytes, additionalData = info) over UTF-8 JSON
 *   info = utf8("arcopolis-cli-grant-v1|" + normalizedUserCode + "|" + cliKeyThumbprint)
 *
 * `decryptGrantEnvelope` mirrors what the CLI does; the page never calls it,
 * but the shared test vector is checked through it.
 */

export const GRANT_ENVELOPE_VERSION = 1;
export const GRANT_ENVELOPE_ALG = "ECDH-ES+HKDF-SHA256+A256GCM";
export const GRANT_INFO_PREFIX = "arcopolis-cli-grant-v1|";
/** Largest plaintext payload, in UTF-8 bytes. */
export const MAX_GRANT_PAYLOAD_BYTES = 8 * 1024;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const COORDINATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SCALAR_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type Bytes = Uint8Array<ArrayBuffer>;

/** Public P-256 JWK exactly as it travels: no `d`, no `key_ops`, no `ext`. */
export interface P256PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

/** Private P-256 JWK; only the CLI (and test fixtures) ever hold one. */
export interface P256PrivateJwk extends P256PublicJwk {
  d: string;
}

export interface GrantEnvelope {
  v: 1;
  alg: typeof GRANT_ENVELOPE_ALG;
  epk: P256PublicJwk;
  salt: string;
  iv: string;
  ct: string;
}

export interface EncryptGrantOptions {
  /** The CLI public key from the grant lookup. */
  publicKey: P256PublicJwk;
  /** Uppercase letters only, e.g. `WDJBMJHT`. */
  normalizedUserCode: string;
  /** Test vectors only: a fixed ephemeral key pair instead of a fresh one. */
  ephemeralPrivateKey?: P256PrivateJwk;
  /** Test vectors only: fixed 16-byte salt. */
  salt?: Uint8Array;
  /** Test vectors only: fixed 12-byte IV. */
  iv?: Uint8Array;
}

/** Error raised when a key, envelope, or payload does not meet §2.7. */
export class GrantEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantEnvelopeError";
  }
}

/** Base64url without padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode base64url (padding optional); throws on any other alphabet. */
export function base64UrlDecode(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new GrantEnvelopeError("Value is not base64url.");
  }
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function utf8(text: string): Bytes {
  return new TextEncoder().encode(text) as Bytes;
}

function copyBytes(bytes: Uint8Array): Bytes {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

/** Accept only a well-formed public P-256 JWK and return it without extra members. */
export function parseP256PublicJwk(value: unknown): P256PublicJwk | null {
  if (!value || typeof value !== "object") return null;
  const { kty, crv, x, y } = value as Record<string, unknown>;
  if (kty !== "EC" || crv !== "P-256") return null;
  if (typeof x !== "string" || !COORDINATE_PATTERN.test(x)) return null;
  if (typeof y !== "string" || !COORDINATE_PATTERN.test(y)) return null;
  return { kty, crv, x, y };
}

function parseP256PrivateJwk(value: P256PrivateJwk): P256PrivateJwk {
  const pub = parseP256PublicJwk(value);
  if (!pub || typeof value.d !== "string" || !SCALAR_PATTERN.test(value.d)) {
    throw new GrantEnvelopeError("Private key is not a P-256 JWK.");
  }
  return { ...pub, d: value.d };
}

/**
 * RFC 7638 JWK thumbprint: SHA-256 over the required members in
 * lexicographic order with no whitespace, base64url encoded.
 */
export async function jwkThumbprint(jwk: P256PublicJwk): Promise<string> {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  const digest = await crypto.subtle.digest("SHA-256", utf8(canonical));
  return base64UrlEncode(new Uint8Array(digest));
}

/** HKDF info and AES-GCM additional data for one grant. */
export function grantInfo(normalizedUserCode: string, cliKeyThumbprint: string): Bytes {
  return utf8(`${GRANT_INFO_PREFIX}${normalizedUserCode}|${cliKeyThumbprint}`);
}

async function importPublicKey(jwk: P256PublicJwk): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey("jwk", { ...jwk, ext: true }, { name: "ECDH", namedCurve: "P-256" }, true, []);
  } catch {
    throw new GrantEnvelopeError("The terminal's public key is not a valid P-256 key.");
  }
}

async function importPrivateKey(jwk: P256PrivateJwk): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey("jwk", { ...jwk, ext: false }, { name: "ECDH", namedCurve: "P-256" }, false, [
      "deriveBits",
    ]);
  } catch {
    throw new GrantEnvelopeError("Private key is not a valid P-256 key.");
  }
}

async function deriveAesKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Bytes,
  info: Bytes,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

function fixedOrRandom(fixed: Uint8Array | undefined, length: number, label: string): Bytes {
  if (fixed) {
    if (fixed.length !== length) throw new GrantEnvelopeError(`${label} must be ${length} bytes.`);
    return copyBytes(fixed);
  }
  return crypto.getRandomValues(new Uint8Array(length));
}

async function ephemeralPair(fixed: P256PrivateJwk | undefined): Promise<{ privateKey: CryptoKey; epk: P256PublicJwk }> {
  if (fixed) {
    const jwk = parseP256PrivateJwk(fixed);
    return { privateKey: await importPrivateKey(jwk), epk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } };
  }
  // The private half is generated non-extractable: it never leaves WebCrypto.
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const epk = parseP256PublicJwk(exported);
  if (!epk) throw new GrantEnvelopeError("Could not export the ephemeral public key.");
  return { privateKey: pair.privateKey, epk };
}

/**
 * Encrypt the provisioning payload for the terminal that owns `publicKey`.
 * The payload is serialized once with `JSON.stringify` and must fit in 8 KB.
 */
export async function encryptGrantPayload(payload: unknown, options: EncryptGrantOptions): Promise<GrantEnvelope> {
  const publicJwk = parseP256PublicJwk(options.publicKey);
  if (!publicJwk) throw new GrantEnvelopeError("The terminal's public key is not a P-256 JWK.");
  if (!/^[A-Z]{8}$/.test(options.normalizedUserCode)) {
    throw new GrantEnvelopeError("The user code must be normalized before encryption.");
  }
  const plaintext = utf8(JSON.stringify(payload));
  if (plaintext.length > MAX_GRANT_PAYLOAD_BYTES) {
    throw new GrantEnvelopeError("The payload is larger than 8 KB.");
  }

  const cliPublicKey = await importPublicKey(publicJwk);
  const info = grantInfo(options.normalizedUserCode, await jwkThumbprint(publicJwk));
  const salt = fixedOrRandom(options.salt, SALT_BYTES, "salt");
  const iv = fixedOrRandom(options.iv, IV_BYTES, "iv");
  const { privateKey, epk } = await ephemeralPair(options.ephemeralPrivateKey);
  const aesKey = await deriveAesKey(privateKey, cliPublicKey, salt, info, "encrypt");
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: info }, aesKey, plaintext);
  plaintext.fill(0);

  return {
    v: GRANT_ENVELOPE_VERSION,
    alg: GRANT_ENVELOPE_ALG,
    epk,
    salt: base64UrlEncode(salt),
    iv: base64UrlEncode(iv),
    ct: base64UrlEncode(new Uint8Array(ciphertext)),
  };
}

/**
 * Decrypt an envelope with the CLI private key and return the UTF-8 JSON
 * text. This is the CLI side of §2.7; the portal uses it only in tests.
 */
export async function decryptGrantEnvelope(
  envelope: GrantEnvelope,
  options: { privateKey: P256PrivateJwk; normalizedUserCode: string },
): Promise<string> {
  if (envelope.v !== GRANT_ENVELOPE_VERSION || envelope.alg !== GRANT_ENVELOPE_ALG) {
    throw new GrantEnvelopeError("Unsupported envelope version or algorithm.");
  }
  const epk = parseP256PublicJwk(envelope.epk);
  if (!epk) throw new GrantEnvelopeError("Envelope epk is not a P-256 JWK.");
  const privateJwk = parseP256PrivateJwk(options.privateKey);
  const salt = base64UrlDecode(envelope.salt);
  const iv = base64UrlDecode(envelope.iv);
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES) {
    throw new GrantEnvelopeError("Envelope salt or iv has the wrong length.");
  }
  const thumbprint = await jwkThumbprint({ kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y });
  const info = grantInfo(options.normalizedUserCode, thumbprint);
  const aesKey = await deriveAesKey(await importPrivateKey(privateJwk), await importPublicKey(epk), salt, info, "decrypt");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: info },
    aesKey,
    base64UrlDecode(envelope.ct),
  );
  return new TextDecoder().decode(plaintext);
}
