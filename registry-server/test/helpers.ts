// Shared test utility for producing a locally-signed Manifest without any
// network access — mirrors scripts/gen-keypair.ts's signing logic so tests
// exercise the exact same signature format real agents would produce.

import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { publicKeyToDidKey, canonicalize } from "../src/identity.js";
import type { Manifest } from "../src/identity.js";

export interface TestAgent {
  agentId: string;
  manifest: Manifest;
  sign(payload: unknown): string;
}

export function createTestAgent(options: {
  walletAddress?: string;
  capabilityTags?: string[];
  priceSchedule?: Record<string, string>;
} = {}): TestAgent {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const agentId = publicKeyToDidKey(Buffer.from(rawPublicKey));

  const walletAddress = options.walletAddress ?? "0x0000000000000000000000000000000000dEaD";
  const capabilityTags = options.capabilityTags ?? ["csv-parsing"];
  const priceSchedule = options.priceSchedule ?? { "csv-parsing": "0.004 USDC" };

  const sign = (payload: unknown): string =>
    cryptoSign(null, Buffer.from(canonicalize(payload), "utf8"), privateKey).toString("base64");

  const unsigned = {
    agent_id: agentId,
    wallet_address: walletAddress,
    capability_tags: capabilityTags,
    price_schedule: priceSchedule,
    sla_seconds: 30,
  };

  const manifest: Manifest = { ...unsigned, signature: sign(unsigned) };

  return { agentId, manifest, sign };
}
