// Dev helper: generates an Ed25519 keypair, derives its did:key, and prints
// a signed manifest skeleton an agent could publish at its manifest_url.
// Real agents do this offline and keep the private key themselves — the
// registry never sees it. This script exists so the registry can be
// exercised end-to-end locally before step 3's toy buyer/seller agents
// (agent-trust-layer-spec.md §6) exist.

import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { publicKeyToDidKey, canonicalize } from "../src/identity.js";

const walletAddress = process.argv[2] ?? "0x0000000000000000000000000000000000dEaD";
const capabilityTag = process.argv[3] ?? "csv-parsing";
const price = process.argv[4] ?? "0.004 USDC";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawPublicKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const agentId = publicKeyToDidKey(Buffer.from(rawPublicKey));

const unsigned = {
  agent_id: agentId,
  wallet_address: walletAddress,
  capability_tags: [capabilityTag],
  price_schedule: { [capabilityTag]: price },
  sla_seconds: 30,
};

const message = Buffer.from(canonicalize(unsigned), "utf8");
const signature = cryptoSign(null, message, privateKey).toString("base64");

const manifest = { ...unsigned, signature };
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

console.log("# agent_id (public, this is the DID — safe to share)");
console.log(agentId);
console.log();
console.log("# private key (SECRET — never publish this, never send it to the registry)");
console.log(privateKeyPem);
console.log();
console.log("# signed manifest — host this JSON verbatim at your manifest_url");
console.log(JSON.stringify(manifest, null, 2));
