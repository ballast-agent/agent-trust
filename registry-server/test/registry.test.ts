import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import * as tools from "../src/tools.js";
import * as escrow from "../../escrow-server/src/tools.js";
import { createTestAgent, type TestAgent } from "./helpers.js";
import { requiredStake, computeReputationScore } from "../src/scoring.js";
import { SlidingWindowRateLimiter } from "../src/ratelimit.js";

function freshDb() {
  return openDatabase(":memory:");
}

// Transactions are no longer seeded directly into the transactions table
// (the old devSeedSettledTransaction helper is gone): submit_review,
// slash_stake, and query_reputation tests drive real transactions through
// escrow-server's business-logic functions in-process â€” the same path real
// MCP traffic takes â€” so every settled/disputed status below was genuinely
// earned rather than fabricated.

function register(db: ReturnType<typeof freshDb>, agent: TestAgent) {
  tools.registerVerifiedAgent(db, agent.manifest, {
    manifest_url: "https://example.test/manifest.json",
    wallet_address: agent.manifest.wallet_address,
    stake_amount: requiredStake(agent.manifest.price_schedule),
  });
}

function setUpEscrowParties() {
  const db = freshDb();
  const buyer = createTestAgent();
  const seller = createTestAgent();
  const arbiter = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0.02 USDC" } });
  for (const a of [buyer, seller, arbiter]) register(db, a);
  return { db, buyer, seller, arbiter };
}

const CREATE_FIELDS = {
  amount: 0.004,
  currency: "USDC",
  task_hash: "sha256:test",
  sla_seconds: 30,
};

/** Drives create -> deliver -> confirm_release to a genuinely settled
 * ('released') transaction, exactly like demo/src/e2e-demo.ts does. */
function settleViaEscrow(
  db: ReturnType<typeof freshDb>,
  buyer: TestAgent,
  seller: TestAgent,
  arbiter: TestAgent
) {
  const createFields = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    ...CREATE_FIELDS,
    arbiter_id: arbiter.agentId,
  };
  const { tx_id } = escrow.createEscrow(db, { ...createFields, signature: buyer.sign(createFields), payee_signature: seller.sign(createFields) });

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
  return tx_id;
}

/** Drives create -> raise_dispute to a genuinely disputed transaction. */
function disputeViaEscrow(
  db: ReturnType<typeof freshDb>,
  buyer: TestAgent,
  seller: TestAgent,
  arbiter: TestAgent
) {
  const createFields = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    ...CREATE_FIELDS,
    arbiter_id: arbiter.agentId,
  };
  const { tx_id } = escrow.createEscrow(db, { ...createFields, signature: buyer.sign(createFields), payee_signature: seller.sign(createFields) });

  const disputeFields = { tx_id, disputer_id: buyer.agentId, reason: "did not deliver" };
  escrow.raiseDispute(db, { ...disputeFields, signature: buyer.sign(disputeFields) });
  return tx_id;
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

test("get_manifest's cache-hit path returns the agent's real sla_seconds and signature, not fabricated values", async () => {
  const db = freshDb();
  const agent = createTestAgent();
  register(db, agent);

  const manifest = await tools.getManifest(db, agent.agentId);

  assert.equal(manifest.sla_seconds, 30, "must reflect the manifest's real claimed SLA, not the old hardcoded 0");
  assert.equal(manifest.signature, agent.manifest.signature, "must reflect the real signature, not an empty string");
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
  const { db, buyer, seller, arbiter } = setUpEscrowParties();
  const outsider = createTestAgent();
  register(db, outsider);

  // Settled the honest way: a full escrowed -> delivered -> released run.
  // Its release auto-attached the payer's correctly-signed satisfied review
  // (escrow-server's confirmRelease), which is itself proof that a valid
  // party review is accepted.
  const tx_id = settleViaEscrow(db, buyer, seller, arbiter);

  // The payee is also a legitimate reviewer of this settled transaction.
  const payeePayload = { tx_id, reviewer_id: seller.agentId, outcome: "satisfied" as const, notes: null };
  const ack = tools.submitReview(db, {
    tx_id,
    reviewer_id: seller.agentId,
    outcome: "satisfied",
    signature: seller.sign(payeePayload),
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
        reviewer_id: buyer.agentId,
        outcome: "satisfied",
        signature: seller.sign({ tx_id, reviewer_id: buyer.agentId, outcome: "satisfied", notes: null }),
      }),
    /does not match/
  );
});

test("submit_review rejects reviews against a non-settled transaction", () => {
  const { db, buyer, seller, arbiter } = setUpEscrowParties();

  // Disputed (not settled) via a real raise_dispute on a real escrow.
  const tx_id = disputeViaEscrow(db, buyer, seller, arbiter);

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
  const { db, buyer, seller, arbiter } = setUpEscrowParties();

  settleViaEscrow(db, buyer, seller, arbiter);
  // confirmRelease already auto-attached the payer's satisfied review to the
  // genuinely settled transaction.

  const reputation = tools.queryReputation(db, seller.agentId);
  assert.equal(reputation.reputation_score, 1);
  assert.equal(reputation.tx_count, 1);
  assert.equal(reputation.dispute_count, 0);
});

test("slash_stake requires a registered arbitration-capable arbiter with a valid signature", () => {
  const { db, buyer, seller, arbiter } = setUpEscrowParties();
  const nonArbiter = createTestAgent();
  register(db, nonArbiter);

  const tx_id = disputeViaEscrow(db, buyer, seller, arbiter);
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

// --- Abuse/rate-limit controls on outbound manifest fetches ------------------
// register_agent and get_manifest's stale-cache refetch both trigger
// server-side fetches of caller-influenced URLs; without limits the registry
// is a free request amplifier pointed at arbitrary third-party hosts.
// Time is injected (SlidingWindowRateLimiter.now), so no test sleeps.

test("sliding-window rate limiter triggers at the cap, spares other keys, and resets as the window slides", () => {
  let fakeNow = 1_000_000;
  const limiter = new SlidingWindowRateLimiter({ maxEvents: 5, windowMs: 60_000 });
  limiter.now = () => fakeNow;

  for (let i = 0; i < 5; i++) {
    limiter.attempt("wallet:wh-attacker");
  }
  assert.throws(() => limiter.attempt("wallet:wh-attacker"), /rate limit exceeded for wallet:wh-attacker/);

  // A different caller is unaffected â€” the budget is per identity.
  limiter.attempt("wallet:wh-honest");

  // Sliding window: stepping forward past the oldest events frees slots â€”
  // this is the "resets appropriately" half, with zero real time elapsed.
  fakeNow += 60_001;
  limiter.attempt("wallet:wh-attacker");
});

test("rejected attempts do not extend the caller's own lockout", () => {
  let fakeNow = 3_000_000;
  const limiter = new SlidingWindowRateLimiter({ maxEvents: 2, windowMs: 60_000 });
  limiter.now = () => fakeNow;

  // Two accepted events at DIFFERENT instants (A at t0, B half a window later).
  limiter.attempt("k");
  fakeNow += 30_000;
  limiter.attempt("k");

  // Hammering while full must not push NEW timestamps into the window
  // (otherwise an attacker could lock themselves in forever by retrying).
  for (let i = 0; i < 50; i++) {
    assert.throws(() => limiter.attempt("k"), /rate limit exceeded/);
  }

  // At t0 + 60_001, event A has slid out of the window but B has not:
  // exactly ONE slot frees, and it refills with this attempt â€” not with any
  // of the 50 rejected ones above.
  fakeNow += 30_001;
  limiter.attempt("k");
  assert.throws(() => limiter.attempt("k"), /rate limit exceeded/);

  // Half a window later B slides out â€” but C (accepted above) is still
  // inside its own window, so exactly one slot is free until we step past
  // C's expiry as well. At +60s beyond C, everything has slid out and both
  // slots are free again.
  fakeNow += 60_001;
  limiter.attempt("k");
  limiter.attempt("k");
  assert.throws(() => limiter.attempt("k"), /rate limit exceeded/);
});

test("register_agent rejects with a rate-limit error BEFORE attempting any network fetch", async () => {
  const db = freshDb();
  const attackerWallet = "wallet-" + "x".repeat(32);
  const attackerUrl = "https://victim-host.example.com/manifest.json";

  // Pre-fill the CALLER bucket directly through the exported instance's own
  // API â€” proving the wiring checks the limit before fetchAndVerifyManifest
  // would ever touch the network (a DNS failure here would surface as a
  // different error entirely).
  for (let i = 0; i < 5; i++) tools.manifestFetchPerCaller.attempt(`wallet:${attackerWallet}`);
  await assert.rejects(
    () =>
      tools.registerAgent(db, {
        manifest_url: attackerUrl,
        wallet_address: attackerWallet,
        stake_amount: 0,
      }),
    /rate limit exceeded/
  );
});
