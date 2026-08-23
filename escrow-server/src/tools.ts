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
import { createHash, randomUUID } from "node:crypto";
import * as db from "../../registry-server/src/db.js";
import { verifySignature, canonicalize } from "../../registry-server/src/identity.js";
import * as registry from "../../registry-server/src/tools.js";

export class EscrowError extends Error {}

const ARBITRATION_TAG = "arbitration";
const QUORUM_SIZE = 3;
/**
 * Minimum stake an arbitration-tagged agent must hold to be eligible for
 * registry_quorum selection (issue #2's sybil-resistance ask: without an
 * economic floor, an attacker floods the pool with near-zero-stake sybils
 * and biases a random draw as effectively as hand-picking did).
 *
 * Value rationale: honest arbiters reach it naturally by claiming a paid
 * arbitration price tier — at the protocol's STAKE_RATIO_K = 50, pricing
 * arbitration at just 0.02 posts exactly 1.0 — while a free ("0 USDC")
 * arbiter stakes nothing and is excluded. Flooding a quorum now costs 3+ ×
 * 1.0 plus a distinct registered identity per sybil, instead of nothing.
 * Deliberately a plain constant, not a market mechanism; revisit once real
 * usage data exists.
 */
export const ARBITER_MIN_STAKE = 1.0;
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
  /** Single pre-selected arbiter — the explicitly opt-in escape hatch.
   * Exactly one of arbiter_id / arbiter_selection must be given — not both,
   * not neither. Does NOT meet spec §4's "no shopping" property (the caller
   * picked the arbiter themselves); use arbiter_selection for that. */
  arbiter_id?: string;
  /** Spec-compliant mode ("registry_quorum"): escrow-server deterministically
   * selects a quorum of exactly 3 from the Registry's registered
   * arbitration-tagged agents (excluding payer and payee), derived from a
   * seed over inputs neither party controls alone. resolve_dispute then
   * requires majority (2 of 3) agreement — agent-trust-layer-spec.md §4. */
  arbiter_selection?: "registry_quorum";
  /** Payer's configured trust floor — spec §3 step 3: refuse the escrow
   * outright if the payee's reputation is below what the payer requires,
   * rather than accepting funds into an escrow the payer wouldn't approve of. */
  min_payee_reputation?: number;
  /** Payer's signature over the payload actually chosen below — either
   * {..., arbiter_id} or {..., arbiter_selection}, matching whichever field was
   * provided, so old single-arbiter callers keep signing exactly what they
   * always signed. Proves the payer actually authorized locking these
   * funds under this specific arbiter set, not just that some caller
   * invoked this tool. */
  signature: string;
  /** The PAYEE's signature over the exact same payload — both parties must
   * accept who gets to rule on disputes over this escrow BEFORE funds lock
   * (issue #2: previously only the payer signed, so a buyer could name three
   * colluding sybil arbiters and later force a refund/slash against a seller
   * who never agreed to any of them). Required in both selection modes. */
  payee_signature: string;
  /**
   * Optional payer-signed "satisfied" review, redeemed ONLY by
   * sweep_auto_release (the automatic release past the grace window).
   *
   * Background: confirm_release bundles the payer's release + review
   * signatures in one call, but sweep_auto_release is genuinely automatic —
   * no payer is reachable to sign at that point, so historically an
   * auto-released transaction settled payment with no review attached.
   * The fix is for the payer to sign the review in advance, here.
   *
   * The signature covers {reviewer_id, outcome, notes, task_hash} — the
   * submitReview payload shape minus tx_id (which doesn't exist yet) plus
   * task_hash, which binds this review to exactly one escrow so it can't be
   * replayed onto another. Redemption rules enforced in sweepAutoRelease:
   * attached only if the transaction's final resolution actually IS the
   * auto-release path; a dispute/refund/manual-confirm resolution never
   * redeems it, and an unverifiable stored signature falls back to the old
   * no-review behavior rather than attaching anything mismatched.
   */
  pre_signed_review?: {
    outcome: "satisfied";
    notes?: string;
    signature: string;
  };
}

/** Resolves which arbitration mode the caller asked for, without yet doing
 * any registry lookups (see createEscrow). */
function resolveArbiterMode(
  input: CreateEscrowInput
): { mode: "single"; arbiter_id: string } | { mode: "registry_quorum" } {
  const hasSingle = input.arbiter_id !== undefined;
  const hasQuorum = input.arbiter_selection !== undefined;
  if (hasSingle === hasQuorum) {
    throw new EscrowError(
      "createEscrow requires exactly one of arbiter_id (single, opt-in) or arbiter_selection: 'registry_quorum'"
    );
  }
  if (input.arbiter_selection !== undefined && input.arbiter_selection !== "registry_quorum") {
    throw new EscrowError(`unknown arbiter_selection '${input.arbiter_selection}' (only 'registry_quorum' is supported)`);
  }
  return hasSingle
    ? { mode: "single", arbiter_id: input.arbiter_id as string }
    : { mode: "registry_quorum" };
}

/** Deterministically selects QUORUM_SIZE arbiters from a pre-sorted pool of
 * eligible agent ids, using a seed neither transacting party controls alone.
 *
 * This is deliberately simple — hash-of-seed indexing without replacement,
 * not a VRF. Its security story (documented in escrow-server/README.md):
 * the seed inputs (server-generated tx_id, server clock, registry-wide
 * agent count) are unknowable to the parties before creation and stored on
 * the transaction row afterward, so the selection can be audited by
 * recomputing it, and neither payer nor payee can steer it toward a
 * specific friendly arbiter.
 *
 * Exported for tests: determinism and party-independence are asserted
 * directly against this function in escrow.test.ts. */
export function selectArbiterQuorum(seedHex: string, poolAgentIds: string[]): string[] {
  if (poolAgentIds.length < QUORUM_SIZE) {
    throw new EscrowError(
      `arbiter pool has only ${poolAgentIds.length} eligible agent(s); a quorum needs ${QUORUM_SIZE}`
    );
  }
  const remaining = [...poolAgentIds];
  const picked: string[] = [];
  const seed = Buffer.from(seedHex, "hex");
  for (let round = 0; round < QUORUM_SIZE; round++) {
    const digest = createHash("sha256").update(seed).update(Buffer.from([round])).digest();
    picked.push(...remaining.splice(digest.readUInt32BE(0) % remaining.length, 1));
  }
  return picked.sort();
}

/** The eligible pool for a registry_quorum selection: every registered
 * arbitration-tagged agent except the two transacting parties themselves
 * (spec §4: "a resolver neither party controls"), filtered down to
 * sybil-resistant members (stake >= ARBITER_MIN_STAKE — see its doc), sorted
 * so selection order is independent of registration order. */
function eligibleArbiterPool(database: DatabaseSync, payerId: string, payeeId: string): string[] {
  return db
    .listAgentsByCapability(database, ARBITRATION_TAG)
    .filter((agent) => agent.agent_id !== payerId && agent.agent_id !== payeeId)
    .filter((agent) => agent.stake_amount >= ARBITER_MIN_STAKE)
    .map((agent) => agent.agent_id)
    .sort();
}

/** Seed over values neither transacting party controls alone:
 * - tx_id: server-side randomUUID, generated after the request arrives
 * - created_at: server clock at creation time
 * - agent count: registry-wide state any participant's registrations move
 * Stored on the transaction row (arbiter_seed) so the selection remains
 * auditable/recomputable after the fact. */
function deriveArbiterSeed(txId: string, createdAtMs: number, database: DatabaseSync): string {
  return createHash("sha256")
    .update(`agenttrust/arbiter-quorum-v1|${txId}|${createdAtMs}|${db.countAgents(database)}`)
    .digest("hex");
}

function assertArbitrationTagged(agent: db.AgentRow, agentId: string): void {
  const tags = JSON.parse(agent.capability_tags) as string[];
  if (!tags.includes(ARBITRATION_TAG)) {
    throw new EscrowError(`arbiter_id ${agentId} does not have the '${ARBITRATION_TAG}' capability tag`);
  }
}

export function createEscrow(database: DatabaseSync, input: CreateEscrowInput) {
  requireAgent(database, input.payer_id, "payer_id");
  requireAgent(database, input.payee_id, "payee_id");

  const selection = resolveArbiterMode(input);

  const basePayload = {
    payer_id: input.payer_id,
    payee_id: input.payee_id,
    amount: input.amount,
    currency: input.currency,
    task_hash: input.task_hash,
    sla_seconds: input.sla_seconds,
  };
  const payload =
    selection.mode === "single"
      ? { ...basePayload, arbiter_id: selection.arbiter_id }
      : { ...basePayload, arbiter_selection: input.arbiter_selection };
  verifyPartySignature(payload, input.payer_id, input.signature, "createEscrow");
  // Payee consent over the identical payload — the anti-sybil fix from
  // issue #2: neither party can impose arbiters the other never accepted.
  verifyPartySignature(payload, input.payee_id, input.payee_signature, "createEscrow (payee consent)");

  // Validate the pre-signed review NOW rather than at redemption time: an
  // unfixable signature should fail the escrow creation outright instead of
  // being silently stored and quietly dropped three weeks later by the sweep.
  let preSignedReview: string | null = null;
  if (input.pre_signed_review !== undefined) {
    if (input.pre_signed_review.outcome !== "satisfied") {
      throw new EscrowError("pre_signed_review.outcome must be 'satisfied' — the payer is pre-approving the optimistic outcome");
    }
    const reviewPayload = {
      reviewer_id: input.payer_id,
      outcome: input.pre_signed_review.outcome,
      notes: input.pre_signed_review.notes ?? null,
      task_hash: input.task_hash,
    };
    verifyPartySignature(
      reviewPayload,
      input.payer_id,
      input.pre_signed_review.signature,
      "createEscrow pre_signed_review"
    );
    preSignedReview = JSON.stringify({
      outcome: input.pre_signed_review.outcome,
      notes: input.pre_signed_review.notes ?? null,
      signature: input.pre_signed_review.signature,
    });
  }

  // Resolve the arbiter set AFTER the payer's authorization check: the
  // payer signs over the MODE they asked for, then the escrow layer either
  // validates their hand-picked single arbiter or derives the spec's
  // randomly-selected quorum from registry state neither party controls.
  const tx_id = randomUUID();
  const now = Date.now();
  let arbiterIds: string[];
  let arbiterSeed: string | null = null;
  if (selection.mode === "single") {
    const arbiter = requireAgent(database, selection.arbiter_id, "arbiter_id");
    assertArbitrationTagged(arbiter, selection.arbiter_id);
    arbiterIds = [selection.arbiter_id];
  } else {
    const pool = eligibleArbiterPool(database, input.payer_id, input.payee_id);
    arbiterSeed = deriveArbiterSeed(tx_id, now, database);
    arbiterIds = selectArbiterQuorum(arbiterSeed, pool);
  }

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
    arbiter_ids: JSON.stringify(arbiterIds),
    pre_signed_review: preSignedReview,
    arbiter_seed: arbiterSeed,
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

  // "verified" here means "delivered, awaiting the payer's confirmation" —
  // reusing the Registry's existing status enum rather than adding a new
  // value for what registry-server's TransactionStatus already calls
  // "verified" (see agent-trust-layer-spec.md §1's status enum). Atomic:
  // guards against two concurrent submit_deliverable calls both applying.
  const applied = db.setDeliverableHash(database, input.tx_id, input.deliverable_hash, Date.now());
  if (!applied) {
    throw new EscrowError(
      `tx_id ${input.tx_id} is no longer awaiting delivery — already delivered or moved on concurrently`
    );
  }

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

  // Atomic: only one of two concurrent confirm_release calls for the same
  // tx_id can win this transition. The loser must never reach
  // submit_review below — that's what would otherwise write two reviews
  // (or hit a raw, unfriendly UNIQUE-constraint error from the reviews
  // table's (tx_id, reviewer_id) primary key instead of a clean rejection).
  const applied = db.setTransactionStatus(database, input.tx_id, ["verified"], "released", Date.now());
  if (!applied) {
    throw new EscrowError(
      `tx_id ${input.tx_id} is no longer awaiting confirmation — already confirmed or moved on concurrently`
    );
  }

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

  // Atomic: closes the race against a concurrent confirm_release (or
  // reclaim_expired) — only one of them can win depending on write order,
  // and the loser must be rejected rather than silently applied on top of
  // an already-moved transaction.
  const applied = db.setTransactionStatus(database, input.tx_id, ["escrowed", "verified"], "disputed", null);
  if (!applied) {
    throw new EscrowError(`tx_id ${input.tx_id} could not be disputed — status changed concurrently`);
  }
  return { ack: true };
}

// --- resolveDispute -------------------------------------------------------

export interface ArbiterAuthorization {
  arbiter_id: string;
  authorization: string;
}

export interface ResolveDisputeInput {
  tx_id: string;
  outcome: "release" | "refund" | "slash";
  reason: string;
  /**
   * One authorization per voting arbiter. A single-arbiter escrow needs
   * exactly 1; a quorum-of-3 escrow needs a majority (2 of 3) agreeing on
   * the same outcome — agent-trust-layer-spec.md §4. Signatures from
   * anyone not in the transaction's pre-selected arbiter set are ignored,
   * not counted as fraud — a caller may harmlessly submit extras.
   */
  authorizations: ArbiterAuthorization[];
}

function requiredVoteCount(arbiterSetSize: number): number {
  return Math.floor(arbiterSetSize / 2) + 1;
}

/** Verifies each candidate's signature over `payload` and returns the ids of
 * those that are both pre-selected for this tx and produced a valid signature. */
function collectValidVotes(
  preSelected: string[],
  authorizations: ArbiterAuthorization[],
  payload: unknown
): string[] {
  const message = Buffer.from(canonicalize(payload), "utf8");
  const valid = new Set<string>();
  for (const { arbiter_id, authorization } of authorizations) {
    if (!preSelected.includes(arbiter_id)) continue; // not pre-selected for this tx — ignored, not an error
    let ok: boolean;
    try {
      ok = verifySignature(arbiter_id, message, authorization);
    } catch {
      ok = false;
    }
    if (ok) valid.add(arbiter_id);
  }
  return [...valid];
}

export function resolveDispute(database: DatabaseSync, input: ResolveDisputeInput) {
  const tx = db.getTransaction(database, input.tx_id);
  if (!tx) throw new EscrowError(`unknown tx_id: ${input.tx_id}`);
  if (tx.status !== "disputed") {
    throw new EscrowError(`tx_id ${input.tx_id} is not disputed (status=${tx.status})`);
  }

  const preSelected = JSON.parse(tx.arbiter_ids) as string[];
  const required = requiredVoteCount(preSelected.length);

  if (input.outcome === "slash") {
    // Count votes over slash_stake's own payload shape, since that's what
    // will actually be forwarded and re-verified there — reuse its
    // arbiter/authorization verification rather than duplicating it.
    const slashPayload = { agent_id: tx.payee_id, tx_id: input.tx_id, reason: input.reason };
    const validVoters = collectValidVotes(preSelected, input.authorizations, slashPayload);
    if (validVoters.length < required) {
      throw new EscrowError(
        `resolveDispute(slash) requires ${required} valid signature(s) from the pre-selected ` +
          `arbiter(s) (agent-trust-layer-spec.md §4); got ${validVoters.length}`
      );
    }
    // Quorum reached — delegate to the Registry using any one agreeing,
    // pre-selected, verified arbiter. slash_stake only needs one legitimate
    // arbitration-tagged authorizer; the quorum check already happened here.
    const [authorizingArbiter] = validVoters;
    const authorization = input.authorizations.find((a) => a.arbiter_id === authorizingArbiter)!.authorization;
    return registry.slashStake(database, {
      agent_id: tx.payee_id,
      tx_id: input.tx_id,
      reason: input.reason,
      arbiter_id: authorizingArbiter,
      authorization,
    });
  }

  const payload = { tx_id: input.tx_id, outcome: input.outcome, reason: input.reason };
  const validVoters = collectValidVotes(preSelected, input.authorizations, payload);
  if (validVoters.length < required) {
    throw new EscrowError(
      `resolveDispute(${input.outcome}) requires ${required} valid signature(s) from the ` +
        `pre-selected arbiter(s) agreeing on '${input.outcome}' (agent-trust-layer-spec.md §4); ` +
        `got ${validVoters.length}`
    );
  }

  const newStatus: db.TransactionStatus = input.outcome === "release" ? "released" : "refunded";
  // Atomic: guards against a second resolve_dispute call (e.g. a
  // conflicting outcome, or a duplicate) applying after this one already
  // resolved the dispute.
  const applied = db.setTransactionStatus(database, input.tx_id, ["disputed"], newStatus, Date.now());
  if (!applied) {
    throw new EscrowError(`tx_id ${input.tx_id} is no longer disputed — resolved concurrently`);
  }
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

  // Atomic: guards against racing a concurrent submit_deliverable/raise_dispute.
  const applied = db.setTransactionStatus(database, input.tx_id, ["escrowed"], "refunded", Date.now());
  if (!applied) {
    throw new EscrowError(`tx_id ${input.tx_id} could not be reclaimed — status changed concurrently`);
  }
  return { ack: true, status: "refunded" as const };
}

// --- sweepAutoRelease -------------------------------------------------------
// spec §3 step 5: "No response from A within a grace window -> auto-release
// (prevents buyers from freeloading by just never confirming)."
//
// Reviews on this path: the Escrow Layer never holds agent private keys (see
// identity-and-onboarding-spec.md), so the sweep cannot sign a review on the
// payer's behalf the way confirmRelease does. Instead, if the payer supplied
// a pre_signed_review at createEscrow time, it is redeemed HERE — and only
// here: redemption requires that the transaction's final resolution actually
// was this automatic release (status transition verified → released won via
// the atomic CAS above; dispute/refund/manual-confirm paths never reach it).
// A stored signature that doesn't verify against the transaction's own
// task_hash/payer falls back to the old no-review behavior rather than
// attaching anything mismatched.

/** Redeems a stored pre-signed review for an auto-released transaction.
 * Best-effort by design: every failure mode degrades to "no review
 * attached", which is exactly the pre-feature behavior. */
function redeemPreSignedReview(database: DatabaseSync, txId: string): void {
  const tx = db.getTransaction(database, txId);
  if (!tx || !tx.pre_signed_review || !tx.task_hash) return;
  let stored: { outcome?: unknown; notes?: unknown; signature?: unknown };
  try {
    stored = JSON.parse(tx.pre_signed_review) as typeof stored;
  } catch {
    return; // corrupt row — degrade to no review
  }
  if (
    typeof stored.signature !== "string" ||
    stored.outcome !== "satisfied" ||
    !(typeof stored.notes === "string" || stored.notes === null)
  ) {
    return;
  }
  const payload = {
    reviewer_id: tx.payer_id,
    outcome: stored.outcome,
    notes: stored.notes,
    task_hash: tx.task_hash,
  };
  try {
    verifyPartySignature(payload, tx.payer_id, stored.signature, "autoRelease pre-signed review");
  } catch {
    return; // signature no longer verifies against this row's facts — attach nothing
  }
  if (db.hasReview(database, tx.tx_id, tx.payer_id)) return;
  const now = Date.now();
  db.insertReview(database, {
    tx_id: tx.tx_id,
    reviewer_id: tx.payer_id,
    outcome: stored.outcome,
    notes: stored.notes,
    signature: stored.signature,
    signed_at: now,
  });
  db.touchLastActive(database, tx.payer_id, now);
}

export function sweepAutoRelease(database: DatabaseSync, graceMs: number = AUTO_RELEASE_GRACE_MS) {
  const now = Date.now();
  const candidates = db.listVerifiedTransactionsOlderThan(database, now - graceMs);
  const released: string[] = [];
  for (const tx of candidates) {
    // Atomic, and skip (not error) on a lost race — a concurrent
    // confirm_release/raise_dispute for the same tx_id between the list
    // query above and this write is a normal outcome for a sweep, not a bug.
    const applied = db.setTransactionStatus(database, tx.tx_id, ["verified"], "released", now);
    if (applied) {
      released.push(tx.tx_id);
      redeemPreSignedReview(database, tx.tx_id);
    }
  }
  return { released_tx_ids: released };
}
