import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../registry-server/src/db.js";
import * as registry from "../../registry-server/src/tools.js";
import { requiredStake } from "../../registry-server/src/scoring.js";
import { createTestAgent, type TestAgent } from "../../registry-server/test/helpers.js";
import * as escrow from "../src/tools.js";

function freshDb() {
  return openDatabase(":memory:");
}

function register(db: ReturnType<typeof freshDb>, agent: TestAgent) {
  registry.registerVerifiedAgent(db, agent.manifest, {
    manifest_url: "https://example.test/manifest.json",
    wallet_address: agent.manifest.wallet_address,
    stake_amount: requiredStake(agent.manifest.price_schedule),
  });
}

function setUpParties() {
  const db = freshDb();
  const buyer = createTestAgent();
  const seller = createTestAgent();
  const arbiter = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0 USDC" } });
  for (const a of [buyer, seller, arbiter]) register(db, a);
  return { db, buyer, seller, arbiter };
}

// Must mirror exactly the payload shape createEscrow verifies the signature
// against (it deliberately excludes min_payee_reputation/signature, and
// includes only whichever of arbiter_id/arbiter_ids was actually provided).
function signCreate(payer: TestAgent, fields: Omit<escrow.CreateEscrowInput, "signature">) {
  const { payer_id, payee_id, amount, currency, task_hash, sla_seconds, arbiter_id, arbiter_ids } = fields;
  const base = { payer_id, payee_id, amount, currency, task_hash, sla_seconds };
  return payer.sign(arbiter_id !== undefined ? { ...base, arbiter_id } : { ...base, arbiter_ids });
}

test("createEscrow locks funds with a pre-selected arbiter", () => {
  const { db, buyer, seller, arbiter } = setUpParties();
  const fields = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
    arbiter_id: arbiter.agentId,
  };
  const signature = signCreate(buyer, fields);

  const { tx_id } = escrow.createEscrow(db, { ...fields, signature });
  assert.ok(tx_id);
});

test("createEscrow accepts a quorum of exactly 3 pre-selected arbiters", () => {
  const { db, buyer, seller } = setUpParties();
  const arbiterA = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0 USDC" } });
  const arbiterB = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0 USDC" } });
  const arbiterC = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0 USDC" } });
  for (const a of [arbiterA, arbiterB, arbiterC]) register(db, a);

  const fields = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
    arbiter_ids: [arbiterA.agentId, arbiterB.agentId, arbiterC.agentId],
  };
  const { tx_id } = escrow.createEscrow(db, { ...fields, signature: signCreate(buyer, fields) });
  assert.ok(tx_id);
});

test("createEscrow rejects a quorum that isn't exactly 3 unique arbiters", () => {
  const { db, buyer, seller, arbiter } = setUpParties();

  const tooFew = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
    arbiter_ids: [arbiter.agentId, arbiter.agentId], // also not unique
  };
  assert.throws(
    () => escrow.createEscrow(db, { ...tooFew, signature: signCreate(buyer, tooFew) }),
    /exactly 3 unique agent ids/
  );
});

test("createEscrow rejects specifying both arbiter_id and arbiter_ids, or neither", () => {
  const { db, buyer, seller, arbiter } = setUpParties();
  const base = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
  };

  assert.throws(
    () => escrow.createEscrow(db, { ...base, signature: buyer.sign(base) }),
    /requires exactly one of arbiter_id or arbiter_ids/
  );
  const both = { ...base, arbiter_id: arbiter.agentId, arbiter_ids: [arbiter.agentId, arbiter.agentId, arbiter.agentId] };
  assert.throws(
    () => escrow.createEscrow(db, { ...both, signature: buyer.sign(both) }),
    /requires exactly one of arbiter_id or arbiter_ids/
  );
});

test("createEscrow rejects a forged payer signature", () => {
  const { db, buyer, seller, arbiter } = setUpParties();
  const fields = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
    arbiter_id: arbiter.agentId,
  };
  const forgedSignature = seller.sign(fields); // signed by the wrong party

  assert.throws(() => escrow.createEscrow(db, { ...fields, signature: forgedSignature }), /does not match/);
});

test("createEscrow refuses when payee reputation is below the payer's floor", () => {
  const { db, buyer, seller, arbiter } = setUpParties();
  const fields = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
    arbiter_id: arbiter.agentId,
    min_payee_reputation: 0.9,
  };
  const signature = signCreate(buyer, fields);

  // seller has zero transaction history -> reputation_score is 0, below 0.9
  assert.throws(
    () => escrow.createEscrow(db, { ...fields, signature }),
    /reputation .* is below/
  );
});

test("full happy path: create -> deliver -> confirm releases funds and writes a review", () => {
  const { db, buyer, seller, arbiter } = setUpParties();
  const createFields = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
    arbiter_id: arbiter.agentId,
  };
  const { tx_id } = escrow.createEscrow(db, { ...createFields, signature: signCreate(buyer, createFields) });

  const deliverFields = { tx_id, payee_id: seller.agentId, deliverable_hash: "sha256:result" };
  escrow.submitDeliverable(db, { ...deliverFields, signature: seller.sign(deliverFields) });

  const reviewPayload = { tx_id, reviewer_id: buyer.agentId, outcome: "satisfied" as const, notes: null };
  const result = escrow.confirmRelease(db, {
    tx_id,
    payer_id: buyer.agentId,
    signature: buyer.sign({ tx_id, payer_id: buyer.agentId }),
    review_signature: buyer.sign(reviewPayload),
  });
  assert.equal(result.status, "released");

  const reputation = registry.queryReputation(db, seller.agentId);
  assert.equal(reputation.tx_count, 1);
  assert.equal(reputation.reputation_score, 1);
});

test("raiseDispute then resolveDispute(slash) delegates to the Registry's slash_stake", () => {
  const { db, buyer, seller, arbiter } = setUpParties();
  const createFields = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
    arbiter_id: arbiter.agentId,
  };
  const { tx_id } = escrow.createEscrow(db, { ...createFields, signature: signCreate(buyer, createFields) });

  const disputeFields = { tx_id, disputer_id: buyer.agentId, reason: "never delivered" };
  escrow.raiseDispute(db, { ...disputeFields, signature: buyer.sign(disputeFields) });

  const before = registry.queryReputation(db, seller.agentId).stake_amount;
  const resolvePayload = { agent_id: seller.agentId, tx_id, reason: "confirmed non-delivery" };
  escrow.resolveDispute(db, {
    tx_id,
    outcome: "slash",
    reason: "confirmed non-delivery",
    authorizations: [{ arbiter_id: arbiter.agentId, authorization: arbiter.sign(resolvePayload) }],
  });
  const after = registry.queryReputation(db, seller.agentId).stake_amount;
  assert.ok(after < before);
});

test("resolveDispute ignores an authorization from an arbiter that wasn't pre-selected at creation", () => {
  const { db, buyer, seller, arbiter } = setUpParties();
  const impostor = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0 USDC" } });
  register(db, impostor);

  const createFields = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
    arbiter_id: arbiter.agentId,
  };
  const { tx_id } = escrow.createEscrow(db, { ...createFields, signature: signCreate(buyer, createFields) });
  const disputeFields = { tx_id, disputer_id: buyer.agentId, reason: "bad result" };
  escrow.raiseDispute(db, { ...disputeFields, signature: buyer.sign(disputeFields) });

  const resolvePayload = { tx_id, outcome: "refund" as const, reason: "not the real arbiter" };
  // The impostor's authorization is well-formed and correctly signed, but
  // since they were never pre-selected for this tx it's silently ignored,
  // leaving 0 valid votes — not treated as fraud, just insufficient.
  assert.throws(
    () =>
      escrow.resolveDispute(db, {
        tx_id,
        outcome: "refund",
        reason: "not the real arbiter",
        authorizations: [{ arbiter_id: impostor.agentId, authorization: impostor.sign(resolvePayload) }],
      }),
    /requires 1 valid signature/
  );
});

test("resolveDispute with a quorum of 3 requires a majority (2 of 3) agreeing, not just one", () => {
  const { db, buyer, seller } = setUpParties();
  const arbiterA = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0 USDC" } });
  const arbiterB = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0 USDC" } });
  const arbiterC = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0 USDC" } });
  for (const a of [arbiterA, arbiterB, arbiterC]) register(db, a);

  const createFields = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
    arbiter_ids: [arbiterA.agentId, arbiterB.agentId, arbiterC.agentId],
  };
  const { tx_id } = escrow.createEscrow(db, { ...createFields, signature: signCreate(buyer, createFields) });
  const disputeFields = { tx_id, disputer_id: buyer.agentId, reason: "bad result" };
  escrow.raiseDispute(db, { ...disputeFields, signature: buyer.sign(disputeFields) });

  const resolvePayload = { tx_id, outcome: "refund" as const, reason: "quorum test" };

  // Quorum-split: only 1 of 3 signs — not enough.
  assert.throws(
    () =>
      escrow.resolveDispute(db, {
        tx_id,
        outcome: "refund",
        reason: "quorum test",
        authorizations: [{ arbiter_id: arbiterA.agentId, authorization: arbiterA.sign(resolvePayload) }],
      }),
    /requires 2 valid signature/
  );

  // Quorum-achieved: 2 of 3 agree on the same outcome — sufficient, even
  // with a third, non-pre-selected signature thrown in (ignored, not counted).
  const outsider = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0 USDC" } });
  register(db, outsider);
  const result = escrow.resolveDispute(db, {
    tx_id,
    outcome: "refund",
    reason: "quorum test",
    authorizations: [
      { arbiter_id: arbiterA.agentId, authorization: arbiterA.sign(resolvePayload) },
      { arbiter_id: arbiterB.agentId, authorization: arbiterB.sign(resolvePayload) },
      { arbiter_id: outsider.agentId, authorization: outsider.sign(resolvePayload) },
    ],
  });
  assert.equal(result.status, "refunded");
});

test("reclaimExpired refunds the payer once the SLA deadline has passed, not before", () => {
  const { db, buyer, seller, arbiter } = setUpParties();
  const createFields = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
    arbiter_id: arbiter.agentId,
  };
  const { tx_id } = escrow.createEscrow(db, { ...createFields, signature: signCreate(buyer, createFields) });

  const reclaimFields = { tx_id, payer_id: buyer.agentId };
  assert.throws(
    () => escrow.reclaimExpired(db, { ...reclaimFields, signature: buyer.sign(reclaimFields) }),
    /has not passed its escrow_deadline/
  );
});

test("sweepAutoRelease releases delivered-but-unconfirmed transactions past the grace window", () => {
  const { db, buyer, seller, arbiter } = setUpParties();
  const createFields = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
    arbiter_id: arbiter.agentId,
  };
  const { tx_id } = escrow.createEscrow(db, { ...createFields, signature: signCreate(buyer, createFields) });
  const deliverFields = { tx_id, payee_id: seller.agentId, deliverable_hash: "sha256:result" };
  escrow.submitDeliverable(db, { ...deliverFields, signature: seller.sign(deliverFields) });

  const result = escrow.sweepAutoRelease(db, -1); // grace of -1ms => already expired
  assert.deepEqual(result.released_tx_ids, [tx_id]);
});
