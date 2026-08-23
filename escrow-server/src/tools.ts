// Escrow Layer business logic — step 2 of
// project-docs/agent-trust-layer-spec.md §3 and §5, as a plain (non-chain)
// state machine per §6 ("no real payment rail yet").
//
// Deliberately reuses registry-server's db.ts and identity.ts rather than
// redefining a parallel schema/verification path — the spec frames this as
// "two services, one shared data model," and DATA_AND_STATE.md's "one
// source of truth" rule means the Transaction row here IS the Registry's
// transactions table, not a copy of it. Both services must be pointed at
// the same SQLite file (see README.md).

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import * as db from "../../registry-server/src/db.js";
import { verifySignature, canonicalize } from "../../registry-server/src/identity.js";
import * as registry from "../../registry-server/src/tools.js";

export class EscrowError extends Error {}

const ARBITRATION_TAG = "arbitration";
const AUTO_RELEASE_GRACE_MS = 24 * 60 * 60 * 1000; // spec §3 step 5: grace window before auto-release

function requireAgent(database: DatabaseSync, agentId: string, label: string): db.AgentRow {
  const agent = db.getAgent(database, agentId);
  if (!agent) throw new EscrowError(`unknown ${label}: ${agentId}`);
  return agent;
}

function verifyPartySignature(payload: unknown, signerId: string, signature: string, context: string) {
  const message = Buffer.from(canonicalize(payload), "utf8");
  let valid: boolean;
  try {
    valid = verifySignature(signerId, message, signature);
  } catch (err) {
    throw new EscrowError(`${context}: signature could not be verified: ${(err as Error).message}`);
  }
  if (!valid) throw new EscrowError(`${context}: signature does not match ${signerId}'s key`);
}

// --- createEscrow -------------------------------------------------------

export interface CreateEscrowInput {
  payer_id: string;
  payee_id: string;
  amount: number;
  currency: string;
  task_hash: string;
  sla_seconds: number;
  arbiter_id: string;
  /** Payer's configured trust floor — spec §3 step 3: refuse the escrow
   * outright if the payee's reputation is below what the payer requires,
   * rather than accepting funds into an escrow the payer wouldn't approve of. */
  min_payee_reputation?: number;
  /** Payer's signature over {payer_id, payee_id, amount, currency, task_hash,
   * sla_seconds, arbiter_id} — proves the payer actually authorized locking
   * these funds, not just that some caller invoked this tool. */
  signature: string;
}

export function createEscrow(database: DatabaseSync, input: CreateEscrowInput) {
  requireAgent(database, input.payer_id, "payer_id");
  requireAgent(database, input.payee_id, "payee_id");

  const arbiter = requireAgent(database, input.arbiter_id, "arbiter_id");
  const arbiterTags = JSON.parse(arbiter.capability_tags) as string[];
  if (!arbiterTags.includes(ARBITRATION_TAG)) {
    throw new EscrowError(`arbiter_id ${input.arbiter_id} does not have the '${ARBITRATION_TAG}' capability tag`);
  }

  const payload = {
    payer_id: input.payer_id,
    payee_id: input.payee_id,
    amount: input.amount,
    currency: input.currency,
    task_hash: input.task_hash,
    sla_seconds: input.sla_seconds,
    arbiter_id: input.arbiter_id,
  };
  verifyPartySignature(payload, input.payer_id, input.signature, "createEscrow");

  if (input.min_payee_reputation !== undefined) {
    const reputation = registry.queryReputation(database, input.payee_id);
    if (reputation.reputation_score < input.min_payee_reputation) {
      throw new EscrowError(
        `payee_id ${input.payee_id} reputation ${reputation.reputation_score} is below the ` +
          `payer's configured floor ${input.min_payee_reputation} — refusing to accept escrow ` +
          `(agent-trust-layer-spec.md §3 step 3)`
      );
    }
  }

  const tx_id = randomUUID();
  const now = Date.now();
  db.insertTransaction(database, {
    tx_id,
    payer_id: input.payer_id,
    payee_id: input.payee_id,
    amount: input.amount,
    currency: input.currency,
    task_hash: input.task_hash,
    deliverable_hash: null,
    status: "escrowed",
    escrow_deadline: now + input.sla_seconds * 1000,
    arbiter_id: input.arbiter_id,
    created_at: now,
    delivered_at: null,
    resolved_at: null,
  });

  return { tx_id };
}

// --- submitDeliverable -------------------------------------------------------

export interface SubmitDeliverableInput {
  tx_id: string;
  payee_id: string;
  deliverable_hash: string;
  signature: string;
}

export function submitDeliverable(database: DatabaseSync, input: SubmitDeliverableInput) {
  const tx = db.getTransaction(database, input.tx_id);
  if (!tx) throw new EscrowError(`unknown tx_id: ${input.tx_id}`);
  if (tx.payee_id !== input.payee_id) {
    throw new EscrowError("payee_id is not the payee of this transaction");
  }
  if (tx.status !== "escrowed") {
    throw new EscrowError(`tx_id ${input.tx_id} is not awaiting delivery (status=${tx.status})`);
  }

  const payload = { tx_id: input.tx_id, payee_id: input.payee_id, deliverable_hash: input.deliverable_hash };
  verifyPartySignature(payload, input.payee_id, input.signature, "submitDeliverable");

  db.setDeliverableHash(database, input.tx_id, input.deliverable_hash);
  // "verified" here means "delivered, awaiting the payer's confirmation" —
  // reusing the Registry's existing status enum rather than adding a new
  // value for what registry-server's TransactionStatus already calls
  // "verified" (see agent-trust-layer-spec.md §1's status enum).
  db.setTransactionStatus(database, input.tx_id, "verified", null);

  return { ack: true };
}

// --- confirmRelease -------------------------------------------------------

export interface ConfirmReleaseInput {
  tx_id: string;
  payer_id: string;
  /** The payer's signature over the confirmRelease action itself. */
  signature: string;
  /**
   * The payer's signature over the automatic satisfied review this release
   * triggers (agent-trust-layer-spec.md §3 step 5: "Escrow Layer auto-calls
   * submit_review"). Required, not optional: the Escrow Layer never holds
   * agent private keys, so it cannot forge a review on the payer's behalf —
   * the payer provides both signatures in one call, which is what makes the
   * review "automatic" from the caller's point of view without weakening
   * the review's authenticity guarantee from identity-and-onboarding-spec.md.
   */
  review_signature: string;
  review_notes?: string;
}

export function confirmRelease(database: DatabaseSync, input: ConfirmReleaseInput) {
  const tx = db.getTransaction(database, input.tx_id);
  if (!tx) throw new EscrowError(`unknown tx_id: ${input.tx_id}`);
  if (tx.payer_id !== input.payer_id) {
    throw new EscrowError("payer_id is not the payer of this transaction");
  }
  if (tx.status !== "verified") {
    throw new EscrowError(`tx_id ${input.tx_id} has no pending delivery to confirm (status=${tx.status})`);
  }

  verifyPartySignature({ tx_id: input.tx_id, payer_id: input.payer_id }, input.payer_id, input.signature, "confirmRelease");

  db.setTransactionStatus(database, input.tx_id, "released", Date.now());

  registry.submitReview(database, {
    tx_id: input.tx_id,
    reviewer_id: input.payer_id,
    outcome: "satisfied",
    notes: input.review_notes,
    signature: input.review_signature,
  });

  return { ack: true, status: "released" as const };
}

// --- raiseDispute -------------------------------------------------------

export interface RaiseDisputeInput {
  tx_id: string;
  disputer_id: string; // must be payer or payee
  reason: string;
  signature: string;
}

export function raiseDispute(database: DatabaseSync, input: RaiseDisputeInput) {
  const tx = db.getTransaction(database, input.tx_id);
  if (!tx) throw new EscrowError(`unknown tx_id: ${input.tx_id}`);
  if (input.disputer_id !== tx.payer_id && input.disputer_id !== tx.payee_id) {
    throw new EscrowError("disputer_id is not a party to this transaction");
  }
  if (tx.status !== "escrowed" && tx.status !== "verified") {
    throw new EscrowError(`tx_id ${input.tx_id} cannot be disputed from status=${tx.status}`);
  }

  const payload = { tx_id: input.tx_id, disputer_id: input.disputer_id, reason: input.reason };
  verifyPartySignature(payload, input.disputer_id, input.signature, "raiseDispute");

  db.setTransactionStatus(database, input.tx_id, "disputed", null);
  return { ack: true };
}

// --- resolveDispute -------------------------------------------------------

export interface ResolveDisputeInput {
  tx_id: string;
  outcome: "release" | "refund" | "slash";
  reason: string;
  arbiter_id: string;
  authorization: string;
}

export function resolveDispute(database: DatabaseSync, input: ResolveDisputeInput) {
  const tx = db.getTransaction(database, input.tx_id);
  if (!tx) throw new EscrowError(`unknown tx_id: ${input.tx_id}`);
  if (tx.status !== "disputed") {
    throw new EscrowError(`tx_id ${input.tx_id} is not disputed (status=${tx.status})`);
  }
  if (tx.arbiter_id !== input.arbiter_id) {
    throw new EscrowError(
      `arbiter_id ${input.arbiter_id} was not the arbiter pre-selected at escrow creation ` +
        `(agent-trust-layer-spec.md §4: neither side may shop for a friendlier arbiter after the fact)`
    );
  }

  if (input.outcome === "slash") {
    // Reuse the Registry's existing slash_stake tool rather than
    // duplicating its arbiter/authorization verification here.
    return registry.slashStake(database, {
      agent_id: tx.payee_id,
      tx_id: input.tx_id,
      reason: input.reason,
      arbiter_id: input.arbiter_id,
      authorization: input.authorization,
    });
  }

  const payload = { tx_id: input.tx_id, outcome: input.outcome, reason: input.reason };
  verifyPartySignature(payload, input.arbiter_id, input.authorization, "resolveDispute");

  const newStatus: db.TransactionStatus = input.outcome === "release" ? "released" : "refunded";
  db.setTransactionStatus(database, input.tx_id, newStatus, Date.now());
  return { ack: true, status: newStatus };
}

// --- reclaimExpired -------------------------------------------------------

export interface ReclaimExpiredInput {
  tx_id: string;
  payer_id: string;
  signature: string;
}

export function reclaimExpired(database: DatabaseSync, input: ReclaimExpiredInput) {
  const tx = db.getTransaction(database, input.tx_id);
  if (!tx) throw new EscrowError(`unknown tx_id: ${input.tx_id}`);
  if (tx.payer_id !== input.payer_id) {
    throw new EscrowError("payer_id is not the payer of this transaction");
  }
  if (tx.status !== "escrowed") {
    throw new EscrowError(`tx_id ${input.tx_id} is not awaiting delivery (status=${tx.status})`);
  }
  if (tx.escrow_deadline === null || Date.now() < tx.escrow_deadline) {
    throw new EscrowError(`tx_id ${input.tx_id} has not passed its escrow_deadline yet`);
  }

  verifyPartySignature({ tx_id: input.tx_id, payer_id: input.payer_id }, input.payer_id, input.signature, "reclaimExpired");

  db.setTransactionStatus(database, input.tx_id, "refunded", Date.now());
  return { ack: true, status: "refunded" as const };
}

// --- sweepAutoRelease -------------------------------------------------------
// spec §3 step 5: "No response from A within a grace window -> auto-release
// (prevents buyers from freeloading by just never confirming)."
//
// Known limitation: this cannot call registry.submitReview on the payer's
// behalf the way confirmRelease does, because it has no payer signature to
// offer — the Escrow Layer never holds agent private keys (see
// identity-and-onboarding-spec.md). An auto-released transaction therefore
// settles payment without a review attached. A future version could let the
// payer pre-sign a conditional "satisfied" review at createEscrow time,
// redeemable only if they never respond — not built here; premature ahead
// of real usage data on how often this path actually triggers.

export function sweepAutoRelease(database: DatabaseSync, graceMs: number = AUTO_RELEASE_GRACE_MS) {
  const now = Date.now();
  const candidates = db.listVerifiedTransactionsOlderThan(database, now - graceMs);
  const released: string[] = [];
  for (const tx of candidates) {
    db.setTransactionStatus(database, tx.tx_id, "released", now);
    released.push(tx.tx_id);
  }
  return { released_tx_ids: released };
}
