// Layer 1 (key control) and Layer 2 (manifest control) verification from
// project-docs/identity-and-onboarding-spec.md.
//
// Design note: a single signed manifest fetch collapses Layers 1 and 2 into
// one check. Only the holder of the DID's private key could have produced a
// valid signature over the manifest payload, so verifying that signature
// against the DID document already proves key control — a separate
// nonce/challenge round trip (as the spec sketches as the general case)
// would be redundant for this synchronous registration flow.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { lookup } from "node:dns/promises";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ED25519_MULTICODEC = Buffer.from([0xed, 0x01]);
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function base58Decode(input: string): Buffer {
  let num = 0n;
  for (const char of input) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`invalid base58 character: ${char}`);
    num = num * 58n + BigInt(index);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bytes = Buffer.from(hex, "hex");
  let leadingZeros = 0;
  for (const char of input) {
    if (char !== "1") break;
    leadingZeros++;
  }
  return Buffer.concat([Buffer.alloc(leadingZeros), bytes]);
}

export function base58Encode(bytes: Buffer): string {
  let num = 0n;
  for (const byte of bytes) num = num * 256n + BigInt(byte);
  let out = "";
  while (num > 0n) {
    const rem = Number(num % 58n);
    out = BASE58_ALPHABET[rem] + out;
    num = num / 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

export function didKeyToPublicKey(did: string): Buffer {
  if (!did.startsWith("did:key:z")) {
    throw new Error(`unsupported DID method, expected did:key: ${did}`);
  }
  const decoded = base58Decode(did.slice("did:key:z".length));
  if (decoded[0] !== ED25519_MULTICODEC[0] || decoded[1] !== ED25519_MULTICODEC[1]) {
    throw new Error("unsupported did:key codec — only Ed25519 (0xed01) is supported");
  }
  return decoded.subarray(2);
}

export function publicKeyToDidKey(publicKey: Buffer): string {
  return "did:key:z" + base58Encode(Buffer.concat([ED25519_MULTICODEC, publicKey]));
}

export function verifySignature(did: string, message: Buffer, signatureBase64: string): boolean {
  const rawPublicKey = didKeyToPublicKey(did);
  const spki = Buffer.concat([SPKI_ED25519_PREFIX, rawPublicKey]);
  const keyObject = createPublicKey({ key: spki, format: "der", type: "spki" });
  const signature = Buffer.from(signatureBase64, "base64");
  return cryptoVerify(null, message, keyObject, signature);
}

/** Deterministic JSON serialization so signer and verifier hash identical bytes. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export interface Manifest {
  agent_id: string;
  wallet_address: string;
  capability_tags: string[];
  price_schedule: Record<string, string>;
  sla_seconds: number;
  signature: string;
}

/**
 * manifest_url is attacker-controlled input (any registering agent can point
 * it anywhere) and this server fetches it server-side, so it's a textbook
 * SSRF vector per SECURITY_GUARDRAILS.md. Mitigations here: https-only,
 * reject redirects rather than follow them blindly, and resolve the hostname
 * to reject private/loopback/link-local ranges before connecting.
 *
 * Gap: this checks the resolved address at lookup time, not the address the
 * TCP connection actually uses (fetch() re-resolves DNS itself), so a
 * TOCTOU/DNS-rebinding attacker who controls their own DNS could still slip
 * through. Closing that fully needs a fetch implementation that connects to
 * a pinned, pre-resolved IP. Acceptable for this prototype; revisit before
 * this registry accepts registrations from untrusted parties in production.
 *
 * AGENTTRUST_ALLOW_LOCAL_MANIFESTS=true bypasses every check in this
 * function entirely. This exists solely so local demo/test scripts (see
 * demo/) can host manifests on 127.0.0.1 without a public HTTPS endpoint.
 * It must never be set outside a local dev/test process — there is no
 * partial bypass here, setting it disables SSRF protection completely.
 */
async function assertSafeManifestUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (process.env.AGENTTRUST_ALLOW_LOCAL_MANIFESTS === "true") {
    console.error(
      "[identity] AGENTTRUST_ALLOW_LOCAL_MANIFESTS=true — SSRF guard fully bypassed for manifest_url. " +
        "Dev/demo use only; never set this in production."
    );
    return url;
  }
  if (url.protocol !== "https:") {
    throw new Error("manifest_url must use https");
  }
  if (url.hostname === "localhost") {
    throw new Error("manifest_url may not target localhost");
  }
  const { address, family } = await lookup(url.hostname);
  if (isPrivateOrReservedIp(address, family)) {
    throw new Error(`manifest_url resolves to a non-public address (${address})`);
  }
  return url;
}

function isPrivateOrReservedIp(address: string, family: number): boolean {
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  const lower = address.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe80")) return true;
  return false;
}

export class ManifestVerificationError extends Error {}

/**
 * Verifies a Manifest's signature against the DID it claims as agent_id —
 * the manifest is self-describing, and did:key means that DID *is* the
 * public key, so a valid signature already proves whoever wrote this
 * manifest holds the matching private key. No external trust anchor is
 * needed to bootstrap that check.
 *
 * This is the single authoritative check — call it at the point a manifest
 * is actually trusted (registration, cache refresh), not only at fetch
 * time, so a caller that already has a Manifest object (e.g. from a test,
 * or a future non-HTTP transport) can't accidentally skip verification by
 * bypassing fetchAndVerifyManifest.
 *
 * Pass expectedAgentId when re-verifying an *already-registered* agent's
 * manifest (e.g. get_manifest's cache refresh) to additionally guard
 * against the agent's manifest_url silently starting to describe a
 * different DID.
 */
export function assertValidManifestSignature(manifest: Manifest, expectedAgentId?: string): void {
  if (expectedAgentId !== undefined && manifest.agent_id !== expectedAgentId) {
    throw new ManifestVerificationError(
      "manifest.agent_id does not match the agent_id being registered — this manifest belongs to a different agent"
    );
  }
  const { signature, ...payload } = manifest;
  if (typeof signature !== "string" || signature.length === 0) {
    throw new ManifestVerificationError("manifest is missing a signature");
  }
  const message = Buffer.from(canonicalize(payload), "utf8");
  let valid: boolean;
  try {
    valid = verifySignature(manifest.agent_id, message, signature);
  } catch (err) {
    throw new ManifestVerificationError(
      `manifest signature could not be verified: ${(err as Error).message}`
    );
  }
  if (!valid) {
    throw new ManifestVerificationError("manifest signature does not match agent_id's key");
  }
}

/**
 * Fetches manifest_url and verifies its signature (via
 * assertValidManifestSignature) before returning it.
 */
export async function fetchAndVerifyManifest(
  manifestUrl: string,
  expectedAgentId?: string
): Promise<Manifest> {
  const url = await assertSafeManifestUrl(manifestUrl);
  const response = await fetch(url, { redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    throw new ManifestVerificationError(
      "manifest_url returned a redirect — redirects are not followed to avoid SSRF via redirect chains"
    );
  }
  if (!response.ok) {
    throw new ManifestVerificationError(`manifest_url fetch failed with status ${response.status}`);
  }
  const manifest = (await response.json()) as Manifest;
  assertValidManifestSignature(manifest, expectedAgentId);
  return manifest;
}
