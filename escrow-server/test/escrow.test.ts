import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, setTransactionStatus, setDeliverableHash, getTransaction } from "../../registry-server/src/db.js";
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

function setUpPartiesInDb(db: ReturnType<typeof freshDb>) {
  const buyer = createTestAgent();
  const seller = createTestAgent();
  const arbiter = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0 USDC" } });
  for (const a of [buyer, seller, arbiter]) register(db, a);
  return { buyer, seller, arbiter };
}

// Must mirror exactly the payload shape createEscrow verifies the signature
// against (it deliberately excludes min_payee_reputation/signature, and
// includes only whichever of arbiter_id/arbiter_ids was actually provided).
function signCreate(payer: TestAgent, fields: Omit<escrow.CreateEscrowInput, "signature">) {
  const { payer_id, payee_id, amount, currency, task_hash, sla_seconds, arbiter_id, arbiter_ids } = fields;
  const base = { payer_id, payee_id, amount, currency, task_hash, sla_seconds };
  return payer.sign(arbiter_id !== undefined ? { ...base, arbiter_id } : { ...base, arbiter_ids });
}

type ContenderResult =
  | { ok: true; result: unknown }
  | { ok: false; name: string; message: string };

interface ChildMessage {
  type: "ready" | "result";
  status?: string | null;
  ok?: boolean;
  result?: unknown;
  name?: string;
  message?: string;
}

const concurrentConfirmReleaseChildPath = fileURLToPath(
  new URL("./concurrent-confirm-release-child.ts", import.meta.url)
);

async function runConcurrentConfirmReleaseAttempts(
  dbPath: string,
  input: escrow.ConfirmReleaseInput,
  contenderCount: number
): Promise<ContenderResult[]> {
  const children: ChildProcess[] = [];
  const readyStatuses: (string | null)[] = [];

  const readiness = Array.from({ length: contenderCount }, () => Promise.withResolvers<void>());
  const results = Array.from({ length: contenderCount }, () => Promise.withResolvers<ContenderResult>());

  for (let index = 0; index < contenderCount; index += 1) {
    const child = fork(concurrentConfirmReleaseChildPath, {
      cwd: new URL("..", import.meta.url),
      execArgv: ["--import", "tsx"],
      env: {
        ...process.env,
        AGENTTRUST_CONCURRENCY_CHILD_CONFIG: JSON.stringify({ dbPath, input }),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("message", (message: ChildMessage) => {
      if (message.type === "ready") {
        readyStatuses[index] = message.status ?? null;
        readiness[index].resolve();
        return;
      }

      if (message.type === "result") {
        if (message.ok === true) {
          results[index].resolve({ ok: true, result: message.result });
        } else {
          results[index].resolve({
            ok: false,
            name: message.name ?? "Error",
            message: message.message ?? "unknown error",
          });
        }
      }
    });

    child.on("error", (err) => {
      readiness[index].reject(err);
      results[index].reject(err);
    });

    child.on("exit", (code, signal) => {
      if (code === 0) return;
      const err = new Error(
        `concurrency child exited with code=${code} signal=${signal ?? "none"} stderr=${stderr.trim()}`
      );
      readiness[index].reject(err);
      results[index].reject(err);
    });
  }

  await Promise.all(readiness.map((ready) => ready.promise));
  assert.deepEqual(
    readyStatuses,
    Array.from({ length: contenderCount }, () => "verified"),
    "every independent contender must observe the same eligible source state before release"
  );

  for (const child of children) {
    child.send({ type: "go" });
  }

  return Promise.all(results.map((result) => result.promise));
}

function countReviewsForTx(db: ReturnType<typeof freshDb>, txId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM reviews WHERE tx_id = ?").get(txId) as { count: number };
  return row.count;
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

// --- Concurrency/idempotency hardening -------------------------------------
// Two "concurrent" MCP tool calls for the same tx_id can't actually
// interleave mid-statement (node:sqlite is synchronous per call), but two
// separate invocations can still both read the same pre-transition status
// before either writes — the classic check-then-act race. These tests
// don't need real threads to prove the guard: calling the same transition
// twice in a row exercises exactly the same SQL-level precondition
// (status = ?) a genuine race would depend on. See db.ts's setTransactionStatus
// and setDeliverableHash doc comments for the actual fix.

test("db.setTransactionStatus's atomic guard: of two identical calls, only one can apply", () => {
  const db = freshDb();
  const buyer = createTestAgent();
  const seller = createTestAgent();
  const arbiter = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0 USDC" } });
  for (const a of [buyer, seller, arbiter]) register(db, a);
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

  // This is the actual race: both calls see the row as 'escrowed' (neither
  // has re-read after the other's write), so a plain read-then-write
  // pattern would let both apply. The atomic UPDATE...WHERE status=?
  // guard means only the first can possibly match.
  const first = setTransactionStatus(db, tx_id, ["escrowed"], "verified", null);
  const second = setTransactionStatus(db, tx_id, ["escrowed"], "verified", null);
  assert.equal(first, true);
  assert.equal(second, false, "the second identical transition must not also apply");
  assert.equal(getTransaction(db, tx_id)?.status, "verified");
});

test("db.setDeliverableHash's atomic guard: the second of two calls cannot overwrite the first hash", () => {
  const db = freshDb();
  const buyer = createTestAgent();
  const seller = createTestAgent();
  const arbiter = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0 USDC" } });
  for (const a of [buyer, seller, arbiter]) register(db, a);
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

  const first = setDeliverableHash(db, tx_id, "sha256:first", Date.now());
  const second = setDeliverableHash(db, tx_id, "sha256:second-should-not-land", Date.now());
  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(getTransaction(db, tx_id)?.deliverable_hash, "sha256:first");
});

test("confirm_release called twice for the same tx_id: second call is rejected, not double-applied", () => {
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
  const confirmInput = {
    tx_id,
    payer_id: buyer.agentId,
    signature: buyer.sign({ tx_id, payer_id: buyer.agentId }),
    review_signature: buyer.sign(reviewPayload),
  };

  const first = escrow.confirmRelease(db, confirmInput);
  assert.equal(first.status, "released");

  // The second call would, without the atomicity fix, either double-apply
  // or throw a raw SQLite UNIQUE-constraint error from the reviews table's
  // (tx_id, reviewer_id) primary key. It must instead be cleanly rejected
  // (here, by the existing fast-path status check, since it re-reads the
  // now-genuinely-updated row — the new atomic guard is the backstop for
  // when that read itself would have been stale, as in a true race).
  assert.throws(() => escrow.confirmRelease(db, confirmInput), /has no pending delivery to confirm/);

  // Exactly one review was recorded, not two.
  const reputation = registry.queryReputation(db, seller.agentId);
  assert.equal(reputation.tx_count, 1);
});

test("concurrent confirm_release attempts from independent processes settle exactly once", async () => {
  const contenderCount = 6;

  for (let iteration = 0; iteration < 5; iteration += 1) {
    const tempDir = mkdtempSync(join(tmpdir(), "agenttrust-escrow-concurrency-"));
    const dbPath = join(tempDir, "trust.sqlite");
    const db = openDatabase(dbPath);
    db.exec("PRAGMA busy_timeout = 2000;");

    try {
      const { buyer, seller, arbiter } = setUpPartiesInDb(db);
      const createFields = {
        payer_id: buyer.agentId,
        payee_id: seller.agentId,
        amount: 0.004,
        currency: "USDC",
        task_hash: `sha256:concurrent-${iteration}`,
        sla_seconds: 30,
        arbiter_id: arbiter.agentId,
      };
      const { tx_id } = escrow.createEscrow(db, { ...createFields, signature: signCreate(buyer, createFields) });

      const deliverFields = { tx_id, payee_id: seller.agentId, deliverable_hash: "sha256:concurrent-result" };
      escrow.submitDeliverable(db, { ...deliverFields, signature: seller.sign(deliverFields) });

      const reviewPayload = { tx_id, reviewer_id: buyer.agentId, outcome: "satisfied" as const, notes: null };
      const confirmInput = {
        tx_id,
        payer_id: buyer.agentId,
        signature: buyer.sign({ tx_id, payer_id: buyer.agentId }),
        review_signature: buyer.sign(reviewPayload),
      };

      const results = await runConcurrentConfirmReleaseAttempts(dbPath, confirmInput, contenderCount);
      const winners = results.filter((result) => result.ok);
      const losers = results.filter((result) => !result.ok);

      assert.equal(winners.length, 1, "exactly one independent contender should win the release");
      assert.equal(losers.length, contenderCount - 1);
      for (const loser of losers) {
        assert.equal(loser.ok, false);
        assert.match(
          loser.message,
          /has no pending delivery to confirm|no longer awaiting confirmation/,
          "losers should be rejected as normal escrow state conflicts"
        );
        assert.doesNotMatch(loser.message, /SQLITE|UNIQUE|constraint/i);
      }

      const tx = getTransaction(db, tx_id);
      assert.ok(tx);
      assert.equal(tx.status, "released");
      assert.equal(tx.deliverable_hash, "sha256:concurrent-result");
      assert.notEqual(tx.resolved_at, null);
      assert.equal(countReviewsForTx(db, tx_id), 1, "only the winning release may insert the satisfied review");

      const reputation = registry.queryReputation(db, seller.agentId);
      assert.equal(reputation.tx_count, 1);
      assert.equal(reputation.reputation_score, 1);
    } finally {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test("submit_deliverable called twice for the same tx_id: second call cannot overwrite the first hash", () => {
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

  const firstDeliver = { tx_id, payee_id: seller.agentId, deliverable_hash: "sha256:first-result" };
  escrow.submitDeliverable(db, { ...firstDeliver, signature: seller.sign(firstDeliver) });

  const secondDeliver = { tx_id, payee_id: seller.agentId, deliverable_hash: "sha256:different-result" };
  assert.throws(
    () => escrow.submitDeliverable(db, { ...secondDeliver, signature: seller.sign(secondDeliver) }),
    /is not awaiting delivery/
  );

  // Confirm the first hash survived untouched — the second call, even
  // though individually well-formed and correctly signed, must not have
  // silently overwritten it.
  const reviewPayload = { tx_id, reviewer_id: buyer.agentId, outcome: "satisfied" as const, notes: null };
  escrow.confirmRelease(db, {
    tx_id,
    payer_id: buyer.agentId,
    signature: buyer.sign({ tx_id, payer_id: buyer.agentId }),
    review_signature: buyer.sign(reviewPayload),
  });
  // (confirmRelease succeeding at all here proves status correctly stayed
  // on the single 'verified' transition from the first submit_deliverable
  // rather than being knocked back to 'escrowed' or duplicated.)
});

test("submit_deliverable is also rejected once confirm_release has already moved the transaction past 'verified'", () => {
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
  escrow.confirmRelease(db, {
    tx_id,
    payer_id: buyer.agentId,
    signature: buyer.sign({ tx_id, payer_id: buyer.agentId }),
    review_signature: buyer.sign(reviewPayload),
  });

  const lateDeliver = { tx_id, payee_id: seller.agentId, deliverable_hash: "sha256:too-late" };
  assert.throws(
    () => escrow.submitDeliverable(db, { ...lateDeliver, signature: seller.sign(lateDeliver) }),
    /is not awaiting delivery/
  );
});

test("raise_dispute racing confirm_release: exactly one wins, the other is rejected", () => {
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

  // confirm_release goes first and wins the 'verified' -> 'released' transition.
  const reviewPayload = { tx_id, reviewer_id: buyer.agentId, outcome: "satisfied" as const, notes: null };
  const confirmed = escrow.confirmRelease(db, {
    tx_id,
    payer_id: buyer.agentId,
    signature: buyer.sign({ tx_id, payer_id: buyer.agentId }),
    review_signature: buyer.sign(reviewPayload),
  });
  assert.equal(confirmed.status, "released");

  // raise_dispute arriving just after must not be able to knock an
  // already-released transaction into 'disputed'.
  const disputeFields = { tx_id, disputer_id: buyer.agentId, reason: "changed my mind" };
  assert.throws(
    () => escrow.raiseDispute(db, { ...disputeFields, signature: buyer.sign(disputeFields) }),
    /cannot be disputed from status=released/
  );
});

test("resolveDispute(slash) called twice for the same disputed tx_id: second call is rejected, stake reduced only once", () => {
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
  const resolveInput = {
    tx_id,
    outcome: "slash" as const,
    reason: "confirmed non-delivery",
    authorizations: [{ arbiter_id: arbiter.agentId, authorization: arbiter.sign(resolvePayload) }],
  };

  escrow.resolveDispute(db, resolveInput);
  const afterFirst = registry.queryReputation(db, seller.agentId).stake_amount;
  assert.ok(afterFirst < before);

  // A second slash for the same tx_id must not reduce stake again — the
  // transaction is no longer 'disputed', so the atomic guard in
  // registry-server's slash_stake must reject it before reduceStake runs.
  assert.throws(() => escrow.resolveDispute(db, resolveInput), /is not disputed/);
  const afterSecond = registry.queryReputation(db, seller.agentId).stake_amount;
  assert.equal(afterSecond, afterFirst, "stake must not be reduced twice");
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

// --- Payee-side reviews of buyers -------------------------------------------
// Only payer->payee reviews were ever written in practice, so buyers
// accumulated no reputation at all and sellers had no signal to evaluate an
// unknown (or repeat-disputing) buyer. confirm_release now optionally takes
// a payee-signed review of the buyer, riding the existing review pipeline.

/** Signs a payee_review payload exactly the way submit_review verifies it:
 * notes omitted => null, matching tools.confirmRelease's pre-verification. */
function signPayeeReview(payee: TestAgent, fields: {
  tx_id: string;
  outcome: "satisfied" | "partial" | "failed";
  notes?: string;
}) {
  return payee.sign({ tx_id: fields.tx_id, reviewer_id: payee.agentId, outcome: fields.outcome, notes: fields.notes ?? null });
}

function deliverAndRelease(
  db: ReturnType<typeof freshDb>,
  parties: { buyer: TestAgent; seller: TestAgent },
  txId: string,
  options: { payeeReview?: { outcome: "satisfied" | "partial" | "failed"; notes?: string } } = {}
) {
  return escrow.confirmRelease(db, {
    tx_id: txId,
    payer_id: parties.buyer.agentId,
    signature: parties.buyer.sign({ tx_id: txId, payer_id: parties.buyer.agentId }),
    review_signature: parties.buyer.sign({
      tx_id: txId,
      reviewer_id: parties.buyer.agentId,
      outcome: "satisfied" as const,
      notes: null,
    }),
    ...(options.payeeReview
      ? { payee_review: { ...options.payeeReview, signature: signPayeeReview(parties.seller, { tx_id: txId, ...options.payeeReview }) } }
      : {}),
  });
}

function runEscrowToEndOfDelivery(
  db: ReturnType<typeof freshDb>,
  parties: { buyer: TestAgent; seller: TestAgent; arbiter: TestAgent },
  taskHash: string
) {
  const createFields = {
    payer_id: parties.buyer.agentId,
    payee_id: parties.seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: taskHash,
    sla_seconds: 30,
    arbiter_id: parties.arbiter.agentId,
  };
  const { tx_id } = escrow.createEscrow(db, { ...createFields, signature: signCreate(parties.buyer, createFields) });
  const deliverFields = { tx_id, payee_id: parties.seller.agentId, deliverable_hash: "sha256:result" };
  escrow.submitDeliverable(db, { ...deliverFields, signature: parties.seller.sign(deliverFields) });
  return tx_id;
}

test("confirm_release records an optional payee-signed review of the buyer", () => {
  const { db, buyer, seller, arbiter } = setUpParties();
  const txId = runEscrowToEndOfDelivery(db, { buyer, seller, arbiter }, "sha256:test");

  const result = deliverAndRelease(db, { buyer, seller }, txId, {
    payeeReview: { outcome: "satisfied" },
  });
  assert.equal(result.status, "released");
  assert.equal(result.payee_review_recorded, true);

  // Both directions landed in the same single review pipeline: two rows for
  // this tx, one authored per party.
  assert.equal(countReviewsForTx(db, txId), 2);

  // The seller's review of the buyer shows up when anyone evaluates the
  // buyer — previously impossible, since only reviews of payees surfaced.
  const buyerReputation = registry.queryReputation(db, buyer.agentId);
  assert.equal(buyerReputation.reputation_score, 1);
  const reviewFromSeller = buyerReputation.recent_reviews.find((r) => r.tx_id === txId && r.reviewer_id === seller.agentId);
  assert.ok(reviewFromSeller, "buyer's recent_reviews must include the seller's review");

  // And the payer side is untouched: the seller's own score still comes
  // only from the buyer's review of them.
  const sellerReputation = registry.queryReputation(db, seller.agentId);
  assert.equal(sellerReputation.reputation_score, 1);
});

test("confirm_release accepts a detailed payee_review with notes", () => {
  const { db, buyer, seller, arbiter } = setUpParties();
  const txId = runEscrowToEndOfDelivery(db, { buyer, seller, arbiter }, "sha256:test");

  deliverAndRelease(db, { buyer, seller }, txId, {
    payeeReview: { outcome: "partial", notes: "slow to respond, but paid up" },
  });

  const buyerReputation = registry.queryReputation(db, buyer.agentId);
  const review = buyerReputation.recent_reviews.find((r) => r.reviewer_id === seller.agentId);
  assert.equal(review?.outcome, "partial");
  assert.equal(review?.notes, "slow to respond, but paid up");
});

test("a forged payee_review rejects the whole call before anything is mutated", () => {
  const { db, buyer, seller, arbiter } = setUpParties();
  const txId = runEscrowToEndOfDelivery(db, { buyer, seller, arbiter }, "sha256:test");

  // Signed by the buyer instead of the payee — the release must not land.
  assert.throws(
    () =>
      escrow.confirmRelease(db, {
        tx_id: txId,
        payer_id: buyer.agentId,
        signature: buyer.sign({ tx_id: txId, payer_id: buyer.agentId }),
        review_signature: buyer.sign({ tx_id: txId, reviewer_id: buyer.agentId, outcome: "satisfied" as const, notes: null }),
        payee_review: {
          outcome: "satisfied",
          signature: buyer.sign({ tx_id: txId, reviewer_id: seller.agentId, outcome: "satisfied" as const, notes: null }),
        },
      }),
    /confirmRelease\(payee_review\).*does not match/
  );

  assert.equal(getTransaction(db, txId)?.status, "verified", "funds must stay escrowed");
  assert.equal(countReviewsForTx(db, txId), 0, "no review may be written either");

  // The same call without the bad attachment succeeds normally.
  deliverAndRelease(db, { buyer, seller }, txId);
  assert.equal(getTransaction(db, txId)?.status, "released");
  assert.equal(countReviewsForTx(db, txId), 1);
});

test("omitting payee_review stays valid and records no buyer-side review", () => {
  const { db, buyer, seller, arbiter } = setUpParties();
  const txId = runEscrowToEndOfDelivery(db, { buyer, seller, arbiter }, "sha256:test");

  const result = deliverAndRelease(db, { buyer, seller }, txId);
  assert.equal(result.payee_review_recorded, false);
  assert.equal(countReviewsForTx(db, txId), 1);
});

test("a repeat-disputing buyer's history is visible to sellers evaluating them", () => {
  const { db, buyer, arbiter } = setUpParties();
  const goodSeller = createTestAgent();
  const burnedSeller = createTestAgent();
  for (const a of [goodSeller, burnedSeller]) register(db, a);

  // Tx 1: clean job, seller leaves a satisfied payee review at release time.
  const tx1 = runEscrowToEndOfDelivery(db, { buyer, seller: goodSeller, arbiter }, "sha256:job-1");
  deliverAndRelease(db, { buyer, seller: goodSeller }, tx1, { payeeReview: { outcome: "satisfied" } });

  // Tx 2: work delivered, then the buyer disputes anyway to claw back funds.
  const tx2 = runEscrowToEndOfDelivery(db, { buyer, seller: burnedSeller, arbiter }, "sha256:job-2");
  const disputeFields = { tx_id: tx2, disputer_id: buyer.agentId, reason: "changed my mind" };
  escrow.raiseDispute(db, { ...disputeFields, signature: buyer.sign(disputeFields) });
  const refundPayload = { tx_id: tx2, outcome: "refund" as const, reason: "changed my mind" };
  escrow.resolveDispute(db, {
    tx_id: tx2,
    outcome: "refund",
    reason: "changed my mind",
    authorizations: [{ arbiter_id: arbiter.agentId, authorization: arbiter.sign(refundPayload) }],
  });
  // Refunded transactions are settled too, so the burned seller can review
  // the buyer directly through the ordinary pipeline.
  registry.submitReview(db, {
    tx_id: tx2,
    reviewer_id: burnedSeller.agentId,
    outcome: "failed",
    signature: burnedSeller.sign({
      tx_id: tx2,
      reviewer_id: burnedSeller.agentId,
      outcome: "failed" as const,
      notes: null,
    }),
  });

  const buyerReputation = registry.queryReputation(db, buyer.agentId);
  // dispute_count only covers *currently-open* disputes — tx2 already
  // resolved to 'refunded', so the durable record of this buyer's conduct
  // is the sellers' authored reviews below, not this counter.
  assert.equal(buyerReputation.dispute_count, 0);
  const sellerAuthored = buyerReputation.recent_reviews.filter((r) =>
    [goodSeller.agentId, burnedSeller.agentId].includes(r.reviewer_id)
  );
  assert.deepEqual(
    sellerAuthored.map((r) => r.outcome).sort(),
    ["failed", "satisfied"],
    "both sellers' judgments of the buyer must surface"
  );
  // Equal-value satisfied + failed reviews average out to ~0.5 — a number a
  // seller can actually price risk against, instead of the invisible
  // "no data" buyers had before.
  assert.ok(buyerReputation.reputation_score > 0.45 && buyerReputation.reputation_score < 0.55);
});
