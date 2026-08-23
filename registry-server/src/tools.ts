// Pure business logic for the Registry MCP tool surface
// (agent-trust-layer-spec.md §2), kept separate from MCP transport wiring so
// it can be unit tested without a running server — see test/registry.test.ts.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import * as db from "./db.js";
import {
  fetchAndVerifyManifest,
  assertValidManifestSignature,
  ManifestVerificationError,
  verifySignature,
  canonicalize,
  type Manifest,
} from "./identity.js";
import { computeReputationScore, requiredStake, type ReviewOutcome } from "./scoring.js";

export class RegistryError extends Error {}

// --- register_agent -------------------------------------------------------

export interface RegisterAgentInput {
  manifest_url: string;
  wallet_address: string;
  stake_amount: number;
  principal_contact?: string;
}

export async function registerAgent(database: DatabaseSync, input: RegisterAgentInput) {
  const manifest = await fetchAndVerifyManifest(input.manifest_url);
  return registerVerifiedAgent(database, manifest, input);
}

/**
 * Core registration logic, split out from the manifest_url fetch so it can
 * be unit tested against a locally-crafted signed Manifest object without
 * a real network round trip — see test/registry.test.ts.
 */
export function registerVerifiedAgent(
  database: DatabaseSync,
  manifest: Manifest,
  input: Omit<RegisterAgentInput, "manifest_url"> & { manifest_url: string }
) {
  try {
    assertValidManifestSignature(manifest);
  } catch (err) {
    if (err instanceof ManifestVerificationError) throw new RegistryError(err.message);
    throw err;
  }

  if (manifest.wallet_address !== input.wallet_address) {
    throw new RegistryError(
      "wallet_address does not match the wallet_address signed into the manifest"
    );
  }

  if (db.getAgent(database, manifest.agent_id)) {
    throw new RegistryError(`agent_id ${manifest.agent_id} is already registered`);
  }

  const minStake = requiredStake(manifest.price_schedule);
  if (input.stake_amount < minStake) {
    throw new RegistryError(
      `stake_amount ${input.stake_amount} is below the required ${minStake} ` +
        `(K=${50} × max claimed price) for this manifest's price_schedule`
    );
  }

  const now = Date.now();
  db.insertAgent(database, {
    agent_id: manifest.agent_id,
    manifest_url: input.manifest_url,
    wallet_address: input.wallet_address,
    stake_amount: input.stake_amount,
    capability_tags: JSON.stringify(manifest.capability_tags),
    price_schedule: JSON.stringify(manifest.price_schedule),
    principal_contact: input.principal_contact ?? null,
    principal_verified: 0,
    manifest_fetched_at: now,
    created_at: now,
    last_active: now,
  });

  return { agent_id: manifest.agent_id };
}

// --- query_reputation -------------------------------------------------------

export function queryReputation(database: DatabaseSync, agentId: string) {
  const agent = db.getAgent(database, agentId);
  if (!agent) throw new RegistryError(`unknown agent_id: ${agentId}`);

  const reviews = db.listReviewsForAgent(database, agentId);
  const reputationScore = computeReputationScore(
    reviews.map((r) => ({
      outcome: r.outcome as ReviewOutcome,
      amount: r.amount,
      resolvedAtMs: r.signed_at,
    }))
  );

  return {
    agent_id: agent.agent_id,
    reputation_score: reputationScore,
    tx_count: db.countTransactionsForAgent(database, agentId),
    dispute_count: db.countDisputesForAgent(database, agentId),
    stake_amount: agent.stake_amount,
    capability_tags: JSON.parse(agent.capability_tags) as string[],
    principal_verified: agent.principal_verified === 1,
    recent_reviews: reviews
      .sort((a, b) => b.signed_at - a.signed_at)
      .slice(0, 10)
      .map((r) => ({ tx_id: r.tx_id, outcome: r.outcome, notes: r.notes, signed_at: r.signed_at })),
  };
}

// --- query_by_capability -------------------------------------------------------

export interface QueryByCapabilityInput {
  capability_tag: string;
  min_reputation?: number;
  max_price?: number;
}

export function queryByCapability(database: DatabaseSync, input: QueryByCapabilityInput) {
  const candidates = db.listAgentsByCapability(database, input.capability_tag);
  const results = [];
  for (const agent of candidates) {
    const priceSchedule = JSON.parse(agent.price_schedule) as Record<string, string>;
    const price = priceSchedule[input.capability_tag];
    if (input.max_price !== undefined && price !== undefined) {
      const numeric = Number.parseFloat(price);
      if (Number.isFinite(numeric) && numeric > input.max_price) continue;
    }
    const reputation = queryReputation(database, agent.agent_id);
    if (input.min_reputation !== undefined && reputation.reputation_score < input.min_reputation) {
      continue;
    }
    results.push({ ...reputation, price_for_tag: price ?? null });
  }
  return results;
}

// --- submit_review -------------------------------------------------------

export interface SubmitReviewInput {
  tx_id: string;
  reviewer_id: string;
  outcome: ReviewOutcome;
  notes?: string;
  signature: string;
}

export function submitReview(database: DatabaseSync, input: SubmitReviewInput) {
  const tx = db.getTransaction(database, input.tx_id);
  if (!tx) throw new RegistryError(`unknown tx_id: ${input.tx_id}`);

  if (!db.SETTLED_STATUSES.includes(tx.status)) {
    throw new RegistryError(
      `tx_id ${input.tx_id} is not settled (status=${tx.status}) — reviews may only ` +
        `attach to a settled transaction`
    );
  }

  if (input.reviewer_id !== tx.payer_id && input.reviewer_id !== tx.payee_id) {
    throw new RegistryError("reviewer_id is not a party to this transaction");
  }

  const payload = {
    tx_id: input.tx_id,
    reviewer_id: input.reviewer_id,
    outcome: input.outcome,
    notes: input.notes ?? null,
  };
  const message = Buffer.from(canonicalize(payload), "utf8");
  let valid: boolean;
  try {
    valid = verifySignature(input.reviewer_id, message, input.signature);
  } catch (err) {
    throw new RegistryError(`review signature could not be verified: ${(err as Error).message}`);
  }
  if (!valid) {
    throw new RegistryError("review signature does not match reviewer_id's key");
  }

  const now = Date.now();
  db.insertReview(database, {
    tx_id: input.tx_id,
    reviewer_id: input.reviewer_id,
    outcome: input.outcome,
    notes: input.notes ?? null,
    signature: input.signature,
    signed_at: now,
  });
  db.touchLastActive(database, input.reviewer_id, now);

  return { ack: true };
}

// --- slash_stake -------------------------------------------------------

export interface SlashStakeInput {
  agent_id: string;
  tx_id: string;
  reason: string;
  arbiter_id: string;
  authorization: string; // arbiter's signature over {agent_id, tx_id, reason}
}

const ARBITRATION_TAG = "arbitration";

export function slashStake(database: DatabaseSync, input: SlashStakeInput) {
  const tx = db.getTransaction(database, input.tx_id);
  if (!tx) throw new RegistryError(`unknown tx_id: ${input.tx_id}`);
  if (tx.status !== "disputed") {
    throw new RegistryError(`tx_id ${input.tx_id} is not disputed (status=${tx.status})`);
  }
  if (input.agent_id !== tx.payer_id && input.agent_id !== tx.payee_id) {
    throw new RegistryError("agent_id is not a party to this transaction");
  }

  const arbiter = db.getAgent(database, input.arbiter_id);
  if (!arbiter) throw new RegistryError(`unknown arbiter_id: ${input.arbiter_id}`);
  const arbiterTags = JSON.parse(arbiter.capability_tags) as string[];
  if (!arbiterTags.includes(ARBITRATION_TAG)) {
    throw new RegistryError(
      `arbiter_id ${input.arbiter_id} does not have the '${ARBITRATION_TAG}' capability tag`
    );
  }

  const payload = { agent_id: input.agent_id, tx_id: input.tx_id, reason: input.reason };
  const message = Buffer.from(canonicalize(payload), "utf8");
  let valid: boolean;
  try {
    valid = verifySignature(input.arbiter_id, message, input.authorization);
  } catch (err) {
    throw new RegistryError(`authorization could not be verified: ${(err as Error).message}`);
  }
  if (!valid) {
    throw new RegistryError("authorization signature does not match arbiter_id's key");
  }

  // Atomic transition first, side effect second — not the other way
  // around. Two concurrent slash_stake calls (or a slash racing a
  // resolve_dispute release/refund) must not both reduce stake: only the
  // call that actually wins the disputed -> slashed transition may apply
  // it. Reducing stake before checking here would let a losing call's
  // reduceStake land even though its own status write then fails.
  const applied = db.setTransactionStatus(database, input.tx_id, ["disputed"], "slashed", Date.now());
  if (!applied) {
    throw new RegistryError(`tx_id ${input.tx_id} is no longer disputed — resolved concurrently`);
  }
  db.reduceStake(database, input.agent_id, tx.amount);

  return { ack: true };
}

// --- get_manifest -------------------------------------------------------

const MANIFEST_CACHE_TTL_MS = 60 * 60 * 1000;

export async function getManifest(database: DatabaseSync, agentId: string): Promise<Manifest> {
  const agent = db.getAgent(database, agentId);
  if (!agent) throw new RegistryError(`unknown agent_id: ${agentId}`);

  const isStale = Date.now() - agent.manifest_fetched_at > MANIFEST_CACHE_TTL_MS;
  if (!isStale) {
    return {
      agent_id: agent.agent_id,
      wallet_address: agent.wallet_address,
      capability_tags: JSON.parse(agent.capability_tags),
      price_schedule: JSON.parse(agent.price_schedule),
      sla_seconds: 0,
      signature: "",
    };
  }

  const manifest = await fetchAndVerifyManifest(agent.manifest_url, agentId);
  db.updateAgentManifestCache(
    database,
    agentId,
    JSON.stringify(manifest.capability_tags),
    JSON.stringify(manifest.price_schedule),
    Date.now()
  );
  return manifest;
}

// --- dev-only seed helper -------------------------------------------------------
// Not part of the spec's public tool surface. The Escrow Layer (escrow-server/)
// and the toy buyer/seller agents (demo/e2e-demo.ts) now both exist and
// produce real settled transactions through the actual MCP protocol — see
// demo/src/e2e-demo.ts for the genuine end-to-end proof. This helper
// remains only as a lighter-weight way to seed a settled transaction for
// this package's own unit tests (registry.test.ts) without spinning up a
// second MCP server process per test.
// TODO: once registry.test.ts's submit_review/slash_stake/query_reputation
// tests are ported to drive transactions through escrow-server's tools
// directly (in-process, no need for the full demo/ subprocess spawn),
// delete this export.

export function devSeedSettledTransaction(
  database: DatabaseSync,
  params: {
    payer_id: string;
    payee_id: string;
    amount: number;
    currency: string;
    task_hash: string;
    status: Extract<db.TransactionStatus, "released" | "refunded" | "disputed">;
  }
) {
  const tx_id = randomUUID();
  const now = Date.now();
  db.insertTransaction(database, {
    tx_id,
    payer_id: params.payer_id,
    payee_id: params.payee_id,
    amount: params.amount,
    currency: params.currency,
    task_hash: params.task_hash,
    deliverable_hash: null,
    status: params.status,
    escrow_deadline: null,
    arbiter_ids: "[]",
    created_at: now,
    delivered_at: null,
    resolved_at: params.status === "disputed" ? null : now,
  });
  return { tx_id };
}
