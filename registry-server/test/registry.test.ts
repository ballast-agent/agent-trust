import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import * as tools from "../src/tools.js";
import { createTestAgent } from "./helpers.js";
import { requiredStake, computeReputationScore } from "../src/scoring.js";

function freshDb() {
  return openDatabase(":memory:");
}

test("registerVerifiedAgent accepts a correctly signed manifest with sufficient stake", () => {
  const db = freshDb();
  const agent = createTestAgent();
  const minStake = requiredStake(agent.manifest.price_schedule);

  const result = tools.registerVerifiedAgent(db, agent.manifest, {
    manifest_url: "https://example.test/manifest.json",
    wallet_address: agent.manifest.wallet_address,
    stake_amount: minStake,
  });

  assert.equal(result.agent_id, agent.agentId);
});

test("registerVerifiedAgent rejects insufficient stake", () => {
  const db = freshDb();
  const agent = createTestAgent({ priceSchedule: { "csv-parsing": "1 USDC" } });
  const minStake = requiredStake(agent.manifest.price_schedule);

  assert.throws(
    () =>
      tools.registerVerifiedAgent(db, agent.manifest, {
        manifest_url: "https://example.test/manifest.json",
        wallet_address: agent.manifest.wallet_address,
        stake_amount: minStake - 1,
      }),
    /stake_amount/
  );
});

test("registerVerifiedAgent rejects a wallet_address mismatch", () => {
  const db = freshDb();
  const agent = createTestAgent();

  assert.throws(
    () =>
      tools.registerVerifiedAgent(db, agent.manifest, {
        manifest_url: "https://example.test/manifest.json",
        wallet_address: "0xSomeoneElsesWallet",
        stake_amount: 1000,
      }),
    /wallet_address/
  );
});

test("registerVerifiedAgent rejects a tampered manifest (signature mismatch)", () => {
  const db = freshDb();
  const agent = createTestAgent();
  const tampered = { ...agent.manifest, price_schedule: { "csv-parsing": "0.0000001 USDC" } };

  assert.throws(() =>
    tools.registerVerifiedAgent(db, tampered, {
      manifest_url: "https://example.test/manifest.json",
      wallet_address: tampered.wallet_address,
      stake_amount: 1000,
    })
  );
});

test("query_by_capability matches complete tags, not substrings", () => {
  const db = freshDb();
  const exactMatch = createTestAgent({
    capabilityTags: ["parsing"],
    priceSchedule: { parsing: "1 USDC" },
  });
  const substringMatch = createTestAgent({
    capabilityTags: ["csv-parsing"],
    priceSchedule: { "csv-parsing": "1 USDC" },
  });

  for (const agent of [exactMatch, substringMatch]) {
    tools.registerVerifiedAgent(db, agent.manifest, {
      manifest_url: "https://example.test/manifest.json",
      wallet_address: agent.manifest.wallet_address,
      stake_amount: requiredStake(agent.manifest.price_schedule),
    });
  }

  const results = tools.queryByCapability(db, { capability_tag: "parsing" });
  assert.deepEqual(results.map((result) => result.agent_id), [exactMatch.agentId]);
});

test("submit_review only accepts reviews from the actual payer/payee, correctly signed", () => {
  const db = freshDb();
  const buyer = createTestAgent();
  const seller = createTestAgent();
  const outsider = createTestAgent();

  for (const a of [buyer, seller]) {
    tools.registerVerifiedAgent(db, a.manifest, {
      manifest_url: "https://example.test/manifest.json",
      wallet_address: a.manifest.wallet_address,
      stake_amount: requiredStake(a.manifest.price_schedule),
    });
  }

  const { tx_id } = tools.devSeedSettledTransaction(db, {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    status: "released",
  });

  const payload = { tx_id, reviewer_id: buyer.agentId, outcome: "satisfied" as const, notes: null };
  const signature = buyer.sign(payload);

  const ack = tools.submitReview(db, {
    tx_id,
    reviewer_id: buyer.agentId,
    outcome: "satisfied",
    signature,
  });
  assert.deepEqual(ack, { ack: true });

  // Outsider (not a party to the tx) cannot review it, even with a valid signature.
  const outsiderPayload = { tx_id, reviewer_id: outsider.agentId, outcome: "satisfied" as const, notes: null };
  assert.throws(
    () =>
      tools.submitReview(db, {
        tx_id,
        reviewer_id: outsider.agentId,
        outcome: "satisfied",
        signature: outsider.sign(outsiderPayload),
      }),
    /not a party/
  );

  // A forged signature (signed by the wrong key) is rejected even from a real party.
  assert.throws(
    () =>
      tools.submitReview(db, {
        tx_id,
        reviewer_id: seller.agentId,
        outcome: "satisfied",
        signature: buyer.sign({ tx_id, reviewer_id: seller.agentId, outcome: "satisfied", notes: null }),
      }),
    /does not match/
  );
});

test("submit_review rejects reviews against a non-settled transaction", () => {
  const db = freshDb();
  const buyer = createTestAgent();
  const seller = createTestAgent();
  for (const a of [buyer, seller]) {
    tools.registerVerifiedAgent(db, a.manifest, {
      manifest_url: "https://example.test/manifest.json",
      wallet_address: a.manifest.wallet_address,
      stake_amount: requiredStake(a.manifest.price_schedule),
    });
  }

  const { tx_id } = tools.devSeedSettledTransaction(db, {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    status: "disputed",
  });

  const payload = { tx_id, reviewer_id: buyer.agentId, outcome: "satisfied" as const, notes: null };
  assert.throws(
    () =>
      tools.submitReview(db, {
        tx_id,
        reviewer_id: buyer.agentId,
        outcome: "satisfied",
        signature: buyer.sign(payload),
      }),
    /not settled/
  );
});

test("query_reputation reflects settled reviews via the decayed scoring formula", () => {
  const db = freshDb();
  const buyer = createTestAgent();
  const seller = createTestAgent();
  for (const a of [buyer, seller]) {
    tools.registerVerifiedAgent(db, a.manifest, {
      manifest_url: "https://example.test/manifest.json",
      wallet_address: a.manifest.wallet_address,
      stake_amount: requiredStake(a.manifest.price_schedule),
    });
  }

  const { tx_id } = tools.devSeedSettledTransaction(db, {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    status: "released",
  });
  const payload = { tx_id, reviewer_id: buyer.agentId, outcome: "satisfied" as const, notes: null };
  tools.submitReview(db, { tx_id, reviewer_id: buyer.agentId, outcome: "satisfied", signature: buyer.sign(payload) });

  const reputation = tools.queryReputation(db, seller.agentId);
  assert.equal(reputation.reputation_score, 1);
  assert.equal(reputation.tx_count, 1);
  assert.equal(reputation.dispute_count, 0);
});

test("query_reputation is symmetric: reviews of a buyer surface too, and never score their author", () => {
  const db = freshDb();
  const buyer = createTestAgent();
  const seller = createTestAgent();
  for (const a of [buyer, seller]) {
    tools.registerVerifiedAgent(db, a.manifest, {
      manifest_url: "https://example.test/manifest.json",
      wallet_address: a.manifest.wallet_address,
      stake_amount: requiredStake(a.manifest.price_schedule),
    });
  }

  const seed = (taskHash: string) =>
    tools.devSeedSettledTransaction(db, {
      payer_id: buyer.agentId,
      payee_id: seller.agentId,
      amount: 0.004,
      currency: "USDC",
      task_hash: taskHash,
      status: "released",
    });

  // Tx 1: the buyer's review of the seller, plus — via the same either-party
  // pipeline — the seller's review of the buyer.
  const { tx_id: tx1 } = seed("sha256:tx1");
  tools.submitReview(db, {
    tx_id: tx1,
    reviewer_id: buyer.agentId,
    outcome: "satisfied",
    signature: buyer.sign({ tx_id: tx1, reviewer_id: buyer.agentId, outcome: "satisfied" as const, notes: null }),
  });
  tools.submitReview(db, {
    tx_id: tx1,
    reviewer_id: seller.agentId,
    outcome: "partial",
    signature: seller.sign({ tx_id: tx1, reviewer_id: seller.agentId, outcome: "partial" as const, notes: null }),
  });

  // Tx 2: another seller->buyer review, on a separate transaction. A review
  // row always judges the reviewer's *counterparty* — the seats determine
  // who is being scored, so nothing needs a "subject_id" field.
  const { tx_id: tx2 } = seed("sha256:tx2");
  tools.submitReview(db, {
    tx_id: tx2,
    reviewer_id: seller.agentId,
    outcome: "satisfied",
    signature: seller.sign({ tx_id: tx2, reviewer_id: seller.agentId, outcome: "satisfied" as const, notes: null }),
  });

  const sellerReputation = tools.queryReputation(db, seller.agentId);
  // Scored ONLY by the buyer's satisfied review of them — the seller's own
  // two writes (which judge the buyer) must not leak into their own score.
  assert.equal(sellerReputation.reputation_score, 1);
  assert.ok(!sellerReputation.recent_reviews.some((r) => r.reviewer_id === seller.agentId));

  const buyerReputation = tools.queryReputation(db, buyer.agentId);
  assert.equal(buyerReputation.tx_count, 2);
  // Two equal-value reviews of the buyer (partial + satisfied) average ~0.75.
  assert.ok(buyerReputation.reputation_score > 0.7 && buyerReputation.reputation_score < 0.8);
  const reviewsFromSeller = buyerReputation.recent_reviews.filter((r) => r.reviewer_id === seller.agentId);
  assert.deepEqual(
    reviewsFromSeller.map((r) => r.outcome).sort(),
    ["partial", "satisfied"],
    "both seller-authored judgments of the buyer must surface"
  );
  // ...and none of the buyer's own reviews-of-sellers leak into their feed.
  assert.ok(!buyerReputation.recent_reviews.some((r) => r.reviewer_id === buyer.agentId));
});

test("slash_stake requires a registered arbitration-capable arbiter with a valid signature", () => {
  const db = freshDb();
  const buyer = createTestAgent();
  const seller = createTestAgent();
  const arbiter = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0 USDC" } });
  const nonArbiter = createTestAgent();

  for (const a of [buyer, seller, arbiter, nonArbiter]) {
    tools.registerVerifiedAgent(db, a.manifest, {
      manifest_url: "https://example.test/manifest.json",
      wallet_address: a.manifest.wallet_address,
      stake_amount: requiredStake(a.manifest.price_schedule),
    });
  }

  const { tx_id } = tools.devSeedSettledTransaction(db, {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    status: "disputed",
  });

  const payload = { agent_id: seller.agentId, tx_id, reason: "did not deliver" };

  // Non-arbiter cannot slash, even with a correctly-signed authorization.
  assert.throws(
    () =>
      tools.slashStake(db, {
        agent_id: seller.agentId,
        tx_id,
        reason: "did not deliver",
        arbiter_id: nonArbiter.agentId,
        authorization: nonArbiter.sign(payload),
      }),
    /arbitration/
  );

  const before = tools.queryReputation(db, seller.agentId).stake_amount;
  const ack = tools.slashStake(db, {
    agent_id: seller.agentId,
    tx_id,
    reason: "did not deliver",
    arbiter_id: arbiter.agentId,
    authorization: arbiter.sign(payload),
  });
  assert.deepEqual(ack, { ack: true });
  const after = tools.queryReputation(db, seller.agentId).stake_amount;
  assert.ok(after < before, "stake should be reduced after a valid slash");
});

test("computeReputationScore weights outcomes by transaction value and decays with age", () => {
  const now = Date.now();
  const score = computeReputationScore(
    [
      { outcome: "satisfied", amount: 100, resolvedAtMs: now },
      { outcome: "failed", amount: 1, resolvedAtMs: now },
    ],
    now
  );
  // The $100 satisfied review should dominate a $1 failed one.
  assert.ok(score > 0.95);
});
