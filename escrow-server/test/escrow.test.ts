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
// against (it deliberately excludes min_payee_reputation/signature).
function signCreate(payer: TestAgent, fields: Omit<escrow.CreateEscrowInput, "signature">) {
  const { payer_id, payee_id, amount, currency, task_hash, sla_seconds, arbiter_id } = fields;
  return payer.sign({ payer_id, payee_id, amount, currency, task_hash, sla_seconds, arbiter_id });
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
    arbiter_id: arbiter.agentId,
    authorization: arbiter.sign(resolvePayload),
  });
  const after = registry.queryReputation(db, seller.agentId).stake_amount;
  assert.ok(after < before);
});

test("resolveDispute rejects an arbiter that wasn't pre-selected at creation", () => {
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
  assert.throws(
    () =>
      escrow.resolveDispute(db, {
        tx_id,
        outcome: "refund",
        reason: "not the real arbiter",
        arbiter_id: impostor.agentId,
        authorization: impostor.sign(resolvePayload),
      }),
    /not the arbiter pre-selected/
  );
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
