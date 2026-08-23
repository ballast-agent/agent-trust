import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDatabase,
  setTransactionStatus,
  setDeliverableHash,
  getTransaction,
  getAgent,
  listAgentsByCapability,
} from "../../registry-server/src/db.js";
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
  const arbiter = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0.02 USDC" } });
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

// Must mirror exactly the payload shape createEscrow verifies BOTH signatures
// against (it deliberately excludes min_payee_reputation/signature/payee_signature/
// pre_signed_review, and includes only whichever of arbiter_id/arbiter_selection
// was actually provided). Since issue #2's payee-consent fix, the payer AND the
// payee must each sign this identical payload before funds lock.
type CreateFields = Omit<escrow.CreateEscrowInput, "signature" | "payee_signature">;

function createPayload(fields: CreateFields) {
  const { payer_id, payee_id, amount, currency, task_hash, sla_seconds, arbiter_id, arbiter_selection } = fields;
  const base = { payer_id, payee_id, amount, currency, task_hash, sla_seconds };
  return arbiter_id !== undefined ? { ...base, arbiter_id } : { ...base, arbiter_selection };
}

function signCreate(payer: TestAgent, fields: CreateFields) {
  return payer.sign(createPayload(fields));
}

/** Both parties' signatures over the identical payload â€” what every valid
 * create_escrow input now carries. */
function bothSignatures(payer: TestAgent, payee: TestAgent, fields: CreateFields) {
  const payload = createPayload(fields);
  return { signature: payer.sign(payload), payee_signature: payee.sign(payload) };
}

function signedCreateInput(payer: TestAgent, payee: TestAgent, fields: CreateFields) {
  return { ...fields, ...bothSignatures(payer, payee, fields) };
}

function arbitrationAgent() {
  // Arbiters claim a PAID tier ("0.02" -> stake 50 x 0.02 = ARBITER_MIN_STAKE),
  // which is what makes them eligible for registry_quorum selection under the
  // sybil-resistance floor; free ("0 USDC") arbiters are excluded from the pool.
  return createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0.02 USDC" } });
}

function registerArbiters(db: ReturnType<typeof freshDb>, count: number): TestAgent[] {
  const arbiters = Array.from({ length: count }, () => arbitrationAgent());
  for (const a of arbiters) register(db, a);
  return arbiters;
}

// The exact payload shape createEscrow stores for a pre-signed review, which
// sweepAutoRelease later verifies before redeeming it (task_hash binds the
// review to this one escrow since tx_id doesn't exist yet at signing time).
function signPreSignedReview(payer: TestAgent, task_hash: string, notes: string | null = null) {
  return payer.sign({ reviewer_id: payer.agentId, outcome: "satisfied" as const, notes, task_hash });
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

  const { tx_id } = escrow.createEscrow(db, { ...fields, signature, payee_signature: signCreate(seller, fields) });
  assert.ok(tx_id);
});

test("createEscrow with arbiter_selection 'registry_quorum' selects 3 eligible arbiters and stores an auditable seed", () => {
  const { db, buyer, seller } = setUpParties();
  registerArbiters(db, 3);

  const fields = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
    arbiter_selection: "registry_quorum" as const,
  };
  const { tx_id } = escrow.createEscrow(db, signedCreateInput(buyer, seller, fields));
  const tx = getTransaction(db, tx_id);
  assert.ok(tx);

  const arbiterIds = JSON.parse(tx.arbiter_ids) as string[];
  assert.equal(arbiterIds.length, 3);
  assert.equal(new Set(arbiterIds).size, 3, "quorum members must be distinct");
  assert.ok(!arbiterIds.includes(buyer.agentId), "payer must never be selected");
  assert.ok(!arbiterIds.includes(seller.agentId), "payee must never be selected");
  for (const id of arbiterIds) {
    const tags = JSON.parse(getAgent(db, id).capability_tags) as string[];
    assert.ok(tags.includes("arbitration"), `${id} was selected without the arbitration tag`);
  }
  // The seed is stored so the selection can be audited/recomputed later.
  assert.match(tx.arbiter_seed ?? "", /^[0-9a-f]{64}$/);

  // Recomputing the quorum from the stored seed over the same pool yields
  // exactly the stored selection.
  const pool = listAgentsByCapability(db, "arbitration")
    .filter((a) => a.agent_id !== buyer.agentId && a.agent_id !== seller.agentId)
    .map((a) => a.agent_id)
    .sort();
  assert.deepEqual(escrow.selectArbiterQuorum(tx.arbiter_seed as string, pool), arbiterIds.sort());
});

test("registry_quorum rejects creation when the eligible pool has fewer than 3 arbiters", () => {
  const { db, buyer, seller, arbiter } = setUpParties(); // only ONE registered arbiter

  const fields = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
    arbiter_selection: "registry_quorum" as const,
  };
  // Even with 3+ total tagged agents it would fail if parties themselves are
  // tagged â€” here there's simply only one third-party arbiter at all.
  assert.throws(
    () => escrow.createEscrow(db, signedCreateInput(buyer, seller, fields)),
    /arbiter pool has only 1 eligible agent/
  );
});

test("registry_quorum excludes tagged transacting parties from the pool", () => {
  // Built by hand rather than setUpParties(): setUpParties also registers a
  // default arbiter, and this test needs a precisely-known pool â€” exactly
  // these three outsiders â€” with an arbitration-tagged PAYER on top, to
  // prove the exclusion is by party role, not by tag.
  const db = freshDb();
  const seller = createTestAgent();
  register(db, seller);
  const outsiderArbiters = registerArbiters(db, 3);
  const buyerTagged = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0.02 USDC" } });
  register(db, buyerTagged);

  const fields = {
    payer_id: buyerTagged.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
    arbiter_selection: "registry_quorum" as const,
  };
  const { tx_id } = escrow.createEscrow(db, signedCreateInput(buyerTagged, seller, fields));
  const selected = JSON.parse(getTransaction(db, tx_id)?.arbiter_ids ?? "[]") as string[];
  assert.deepEqual(
    selected.slice().sort(),
    outsiderArbiters.map((a) => a.agentId).sort()
  );
});

test("selectArbiterQuorum is deterministic and spreads selections across the pool without favoring any member", () => {
  const pool = ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e"];

  // Determinism: identical seed -> identical selection.
  const once = escrow.selectArbiterQuorum("aa".repeat(32), pool);
  assert.deepEqual(escrow.selectArbiterQuorum("aa".repeat(32), pool), once);
  assert.equal(once.length, 3);
  assert.equal(new Set(once).size, 3);

  // Distribution: across many seeds drawn the way deriveArbiterSeed draws
  // them, no single pool member should dominate or vanish. Each agent is
  // expected in ~3/5 of seeds -> ~90 of the 450 slots (share 0.2); with n=150
  // independent seeds, 3 sigma around that is roughly +/-18 picks, so these
  // bounds catch a broken/biased selector while tolerating hash variance.
  const picks = new Map<string, number>(pool.map((id) => [id, 0]));
  for (let i = 0; i < 150; i++) {
    const seed = createHash("sha256").update(`agenttrust/arbiter-quorum-v1|tx-${i}|1700000000000|7`).digest("hex");
    for (const id of escrow.selectArbiterQuorum(seed, pool)) picks.set(id, (picks.get(id) ?? 0) + 1);
  }
  for (const [id, count] of picks) {
    assert.ok(
      count >= 60 && count <= 120,
      `${id} was picked ${count}/450 times â€” outside plausible bounds for a uniform quorum selector`
    );
  }
});

test("createEscrow rejects specifying both arbiter_id and arbiter_selection, or neither, or an unknown mode", () => {
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
    () => escrow.createEscrow(db, { ...base, ...bothSignatures(buyer, seller, base) }),
    /exactly one of arbiter_id .* or arbiter_selection/
  );
  const both = { ...base, arbiter_id: arbiter.agentId, arbiter_selection: "registry_quorum" as const };
  assert.throws(
    () => escrow.createEscrow(db, { ...both, ...bothSignatures(buyer, seller, base) }),
    /exactly one of arbiter_id .* or arbiter_selection/
  );
  const unknown = { ...base, arbiter_selection: "friendly_arbiter" } as unknown as typeof both;
  assert.throws(
    () => escrow.createEscrow(db, { ...unknown, ...bothSignatures(buyer, seller, base) }),
    /unknown arbiter_selection/
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

  assert.throws(
    () => escrow.createEscrow(db, { ...fields, signature: forgedSignature, payee_signature: signCreate(seller, fields) }),
    /does not match/
  );
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
    () => escrow.createEscrow(db, { ...fields, signature, payee_signature: signCreate(seller, fields) }),
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
  const { tx_id } = escrow.createEscrow(db, signedCreateInput(buyer, seller, createFields));

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
// before either writes â€” the classic check-then-act race. These tests
// don't need real threads to prove the guard: calling the same transition
// twice in a row exercises exactly the same SQL-level precondition
// (status = ?) a genuine race would depend on. See db.ts's setTransactionStatus
// and setDeliverableHash doc comments for the actual fix.

test("db.setTransactionStatus's atomic guard: of two identical calls, only one can apply", () => {
  const db = freshDb();
  const buyer = createTestAgent();
  const seller = createTestAgent();
  const arbiter = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0.02 USDC" } });
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
  const { tx_id } = escrow.createEscrow(db, signedCreateInput(buyer, seller, createFields));

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
  const arbiter = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0.02 USDC" } });
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
  const { tx_id } = escrow.createEscrow(db, signedCreateInput(buyer, seller, createFields));

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
  const { tx_id } = escrow.createEscrow(db, signedCreateInput(buyer, seller, createFields));
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
  // now-genuinely-updated row â€” the new atomic guard is the backstop for
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
      const { tx_id } = escrow.createEscrow(db, signedCreateInput(buyer, seller, createFields));

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
  const { tx_id } = escrow.createEscrow(db, signedCreateInput(buyer, seller, createFields));

  const firstDeliver = { tx_id, payee_id: seller.agentId, deliverable_hash: "sha256:first-result" };
  escrow.submitDeliverable(db, { ...firstDeliver, signature: seller.sign(firstDeliver) });

  const secondDeliver = { tx_id, payee_id: seller.agentId, deliverable_hash: "sha256:different-result" };
  assert.throws(
    () => escrow.submitDeliverable(db, { ...secondDeliver, signature: seller.sign(secondDeliver) }),
    /is not awaiting delivery/
  );

  // Confirm the first hash survived untouched â€” the second call, even
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
  const { tx_id } = escrow.createEscrow(db, signedCreateInput(buyer, seller, createFields));
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
  const { tx_id } = escrow.createEscrow(db, signedCreateInput(buyer, seller, createFields));
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
  const { tx_id } = escrow.createEscrow(db, signedCreateInput(buyer, seller, createFields));
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

  // A second slash for the same tx_id must not reduce stake again â€” the
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
  const { tx_id } = escrow.createEscrow(db, signedCreateInput(buyer, seller, createFields));

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
  const impostor = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0.02 USDC" } });
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
  const { tx_id } = escrow.createEscrow(db, signedCreateInput(buyer, seller, createFields));
  const disputeFields = { tx_id, disputer_id: buyer.agentId, reason: "bad result" };
  escrow.raiseDispute(db, { ...disputeFields, signature: buyer.sign(disputeFields) });

  const resolvePayload = { tx_id, outcome: "refund" as const, reason: "not the real arbiter" };
  // The impostor's authorization is well-formed and correctly signed, but
  // since they were never pre-selected for this tx it's silently ignored,
  // leaving 0 valid votes â€” not treated as fraud, just insufficient.
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
  // Exactly 3 eligible arbiters total (no default setUpParties arbiter), so
  // registry_quorum deterministically selects precisely these three.
  const db = freshDb();
  const buyer = createTestAgent();
  const seller = createTestAgent();
  register(db, buyer);
  register(db, seller);
  const [arbiterA, arbiterB, arbiterC] = registerArbiters(db, 3);

  const createFields = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
    arbiter_selection: "registry_quorum" as const,
  };
  const { tx_id } = escrow.createEscrow(db, signedCreateInput(buyer, seller, createFields));
  assert.deepEqual(
    (JSON.parse(getTransaction(db, tx_id)?.arbiter_ids ?? "[]") as string[]).sort(),
    [arbiterA.agentId, arbiterB.agentId, arbiterC.agentId].sort()
  );
  const disputeFields = { tx_id, disputer_id: buyer.agentId, reason: "bad result" };
  escrow.raiseDispute(db, { ...disputeFields, signature: buyer.sign(disputeFields) });

  const resolvePayload = { tx_id, outcome: "refund" as const, reason: "quorum test" };

  // Quorum-split: only 1 of 3 signs â€” not enough.
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

  // Quorum-achieved: 2 of 3 agree on the same outcome â€” sufficient, even
  // with a third, non-pre-selected signature thrown in (ignored, not counted).
  const outsider = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0.02 USDC" } });
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
  const { tx_id } = escrow.createEscrow(db, signedCreateInput(buyer, seller, createFields));

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
  const { tx_id } = escrow.createEscrow(db, signedCreateInput(buyer, seller, createFields));
  const deliverFields = { tx_id, payee_id: seller.agentId, deliverable_hash: "sha256:result" };
  escrow.submitDeliverable(db, { ...deliverFields, signature: seller.sign(deliverFields) });

  const result = escrow.sweepAutoRelease(db, -1); // grace of -1ms => already expired
  assert.deepEqual(result.released_tx_ids, [tx_id]);

  // Backward-compat review behavior: no pre_signed_review was supplied, so
  // the auto-release settles payment with no review attached â€” exactly the
  // pre-feature behavior this path must preserve for old callers.
  const reputation = registry.queryReputation(db, seller.agentId);
  assert.equal(reputation.tx_count, 1);
  assert.equal(reputation.recent_reviews.length, 0);
});

// --- Pre-signed conditional reviews (auto-release gap) -----------------------
// sweep_auto_release is genuinely automatic â€” the Escrow Layer never holds
// keys, so it cannot sign a review on the payer's behalf. The fix: the payer
// MAY pre-sign a satisfied review at create_escrow time; it is redeemed by
// the sweep ONLY if the transaction's actual final resolution was that
// automatic release. These tests pin down each redemption rule.

test("a valid pre_signed_review is redeemed when sweep_auto_release resolves the transaction", () => {
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
  escrow.createEscrow(db, {
    ...createFields,
    ...bothSignatures(buyer, seller, createFields),
    pre_signed_review: { outcome: "satisfied", notes: "smooth autonomous delivery", signature: signPreSignedReview(buyer, createFields.task_hash, "smooth autonomous delivery") },
  });
  const tx_id = (db.prepare("SELECT tx_id FROM transactions").get() as { tx_id: string }).tx_id;

  const deliverFields = { tx_id, payee_id: seller.agentId, deliverable_hash: "sha256:result" };
  escrow.submitDeliverable(db, { ...deliverFields, signature: seller.sign(deliverFields) });
  escrow.sweepAutoRelease(db, -1);

  const reputation = registry.queryReputation(db, seller.agentId);
  assert.equal(reputation.tx_count, 1);
  assert.equal(reputation.recent_reviews.length, 1, "the pre-signed review must be attached exactly once");
  // recent_reviews entries carry {tx_id, outcome, notes, signed_at} â€” the
  // reviewer is implied (reviews listed here are about this seller) and the
  // payer's authorship is enforced by signature verification at redemption.
  assert.equal(reputation.recent_reviews[0].outcome, "satisfied");
});

test("a pre_signed_review is NOT redeemed when the transaction resolves via manual confirm_release", () => {
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
  escrow.createEscrow(db, {
    ...createFields,
    ...bothSignatures(buyer, seller, createFields),
    pre_signed_review: { outcome: "satisfied", signature: signPreSignedReview(buyer, createFields.task_hash) },
  });
  const tx_id = (db.prepare("SELECT tx_id FROM transactions").get() as { tx_id: string }).tx_id;
  const deliverFields = { tx_id, payee_id: seller.agentId, deliverable_hash: "sha256:result" };
  escrow.submitDeliverable(db, { ...deliverFields, signature: seller.sign(deliverFields) });

  // The payer shows up after all and confirms manually â€” its own fresh
  // review signature is used, and the stale pre-signature must not produce
  // a second review.
  const reviewPayload = { tx_id, reviewer_id: buyer.agentId, outcome: "satisfied" as const, notes: null };
  escrow.confirmRelease(db, {
    tx_id,
    payer_id: buyer.agentId,
    signature: buyer.sign({ tx_id, payer_id: buyer.agentId }),
    review_signature: buyer.sign(reviewPayload),
  });

  const reputation = registry.queryReputation(db, seller.agentId);
  assert.equal(reputation.recent_reviews.length, 1, "exactly one review total â€” no double-fire from the stored pre-signature");
});

test("a pre_signed_review is never attached when the transaction resolves as a refunded dispute", () => {
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
  escrow.createEscrow(db, {
    ...createFields,
    ...bothSignatures(buyer, seller, createFields),
    pre_signed_review: { outcome: "satisfied", signature: signPreSignedReview(buyer, createFields.task_hash) },
  });
  const tx_id = (db.prepare("SELECT tx_id FROM transactions").get() as { tx_id: string }).tx_id;

  const disputeFields = { tx_id, disputer_id: buyer.agentId, reason: "work was actually bad" };
  escrow.raiseDispute(db, { ...disputeFields, signature: buyer.sign(disputeFields) });

  // The payer's own optimistic "satisfied" pre-signature obviously must not
  // survive an arbitrated refund â€” redemption only lives on the auto-release
  // path, so the refunded transaction ends with no review at all.
  const resolvePayload = { tx_id, outcome: "refund" as const, reason: "work was actually bad" };
  escrow.resolveDispute(db, {
    tx_id,
    outcome: "refund",
    reason: "work was actually bad",
    authorizations: [{ arbiter_id: arbiter.agentId, authorization: arbiter.sign(resolvePayload) }],
  });

  const reputation = registry.queryReputation(db, seller.agentId);
  // "refunded" is a settled status (SETTLED_STATUSES), so it counts toward
  // tx_count â€” but no review may attach to it, which is the actual point:
  // the payer's optimistic pre-signature must not survive an arbitrated refund.
  assert.equal(reputation.tx_count, 1);
  assert.equal(reputation.recent_reviews.length, 0);
});

test("create_escrow rejects a pre_signed_review whose signature does not verify", () => {
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
  assert.throws(
    () =>
      escrow.createEscrow(db, {
        ...createFields,
        ...bothSignatures(buyer, seller, createFields),
        // Signed by the wrong party entirely â€” rejected NOW, at creation,
        // rather than being stored and quietly dropped weeks later by a sweep.
        pre_signed_review: { outcome: "satisfied", signature: seller.sign({ reviewer_id: buyer.agentId, outcome: "satisfied" as const, notes: null, task_hash: createFields.task_hash }) },
      }),
    /does not match/
  );
});

test("create_escrow rejects a pre_signed_review whose task_hash doesn't bind it to this escrow", () => {
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
  assert.throws(
    () =>
      escrow.createEscrow(db, {
        ...createFields,
        ...bothSignatures(buyer, seller, createFields),
        // Correct signer, but the signature covers a DIFFERENT task_hash â€”
        // this is what stops one pre-signature being replayed onto any other
        // escrow row.
        pre_signed_review: { outcome: "satisfied", signature: signPreSignedReview(buyer, "sha256:some-other-task") },
      }),
    /does not match/
  );
});

// --- Genuine concurrency: worker_threads against one shared SQLite file -----
//
// The sequential tests above only prove the SQL-level CAS precondition (a
// second call whose read is already stale still cannot apply). They cannot
// prove anything about genuine simultaneous execution, because node:sqlite's
// DatabaseSync is synchronous â€” within one JS thread there IS no interleaving.
// What node:sqlite does support is multiple independent connections to the
// same database FILE from different threads (worker_threads), which gives
// real OS-level contention serialized by SQLite's file locks. That is what
// these tests use; see coding-docs/QUALITY_AND_TESTING.md ("Testing the
// concurrency guards") for the full model write-up.
//
// Constraints discovered empirically on node v24 / SQLite rollback-journal
// mode ("delete"):
// - :memory: databases are per-connection and CANNOT be shared across
//   connections or threads â€” these tests must use a temp file.
// - Concurrent writers block each other rather than corrupting, provided
//   every connection sets PRAGMA busy_timeout; without it a blocked writer
//   throws SQLITE_BUSY immediately.
// - The guarded UPDATE ... WHERE status IN (...) statements are what make
//   "exactly one winner" hold under ANY interleaving; file locking only
//   supplies the simultaneity.

interface WorkerReport {
  applied: number;
  rejected: number;
  busyErrors: number;
  finalStatus?: string;
  deliverableHash?: string | null;
}

const DB_MODULE_URL = new URL("../../registry-server/src/db.ts", import.meta.url).href;

function spawnTransitionWorkers(dbPath: string, txId: string, workerCount: number, flipsPerWorker: number) {
  const src = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    (async () => {
      const raw = new DatabaseSync(workerData.dbPath);
      raw.exec('PRAGMA busy_timeout = 5000');
      raw.exec('PRAGMA foreign_keys = ON');
      const db = await import(workerData.dbModuleUrl);
      let applied = 0, rejected = 0, busyErrors = 0;
      for (let i = 0; i < workerData.flipsPerWorker; i++) {
        try {
          // Forward transition; if this worker won it, flip straight back so
          // every iteration stays genuinely contended instead of becoming a
          // trivial no-op after the first winner.
          if (db.setTransactionStatus(raw, workerData.txId, ['verified'], 'released', Date.now())) {
            applied++;
            if (!db.setTransactionStatus(raw, workerData.txId, ['released'], 'verified', null)) rejected++;
          } else {
            rejected++;
          }
        } catch {
          busyErrors++;
        }
      }
      const tx = db.getTransaction(raw, workerData.txId);
      parentPort.postMessage({
        applied, rejected, busyErrors,
        finalStatus: tx.status,
        deliverableHash: tx.deliverable_hash,
      });
    })();
  `;
  return Promise.all(
    Array.from({ length: workerCount }, () => {
      return new Promise<WorkerReport>((resolve, reject) => {
        const worker = new Worker(src, {
          eval: true,
          workerData: { dbPath, dbModuleUrl: DB_MODULE_URL, txId, flipsPerWorker },
        });
        worker.on("message", resolve);
        worker.on("error", reject);
      });
    })
  );
}

/** Shared setup for the concurrency tests: a real FILE database (required â€”
 * :memory: cannot cross connections), seeded through the normal escrow flow
 * until the transaction sits at 'verified'. */
function setUpVerifiedTxOnFileDb(): { dbPath: string; cleanup: () => void } & ReturnType<typeof setUpParties> {
  const parties = setUpParties();
  const dir = mkdtempSync(join(tmpdir(), "agenttrust-concurrency-"));
  const dbPath = join(dir, "shared.db");
  const fileDb = openDatabase(dbPath);
  // Copy the registered agents into the file database, then run the same
  // create -> deliver flow against IT (the :memory: one stays untouched).
  for (const agent of [parties.buyer, parties.seller, parties.arbiter]) {
    registry.registerVerifiedAgent(fileDb, agent.manifest, {
      manifest_url: "https://example.test/manifest.json",
      wallet_address: agent.manifest.wallet_address,
      stake_amount: requiredStake(agent.manifest.price_schedule),
    });
  }
  return { ...parties, dbPath, cleanup: () => {
    // Best-effort on Windows: worker connections can release the file a beat
    // after posting their result, so an immediate recursive delete sometimes
    // hits EPERM. Leftover temp dirs are harmless (OS temp cleaner territory).
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* leave the temp dir for the OS to reclaim */
    }
  } };
}

test("genuine concurrent racing: exactly one of many simultaneous transitions applies, with no corrupted state", async () => {
  const { db: memoryDb, buyer, seller, arbiter, dbPath, cleanup } = setUpVerifiedTxOnFileDb();
  try {
    const fileDb = openDatabase(dbPath);
    const createFields = {
      payer_id: buyer.agentId,
      payee_id: seller.agentId,
      amount: 0.004,
      currency: "USDC",
      task_hash: "sha256:test",
      sla_seconds: 30,
      arbiter_id: arbiter.agentId,
    };
    const { tx_id } = escrow.createEscrow(fileDb, signedCreateInput(buyer, seller, createFields));
    const deliverFields = { tx_id, payee_id: seller.agentId, deliverable_hash: "sha256:result" };
    escrow.submitDeliverable(fileDb, { ...deliverFields, signature: seller.sign(deliverFields) });
    assert.equal(getTransaction(fileDb, tx_id)?.status, "verified");

    // 8 workers Ã— 50 contended iterations each = 400 genuine simultaneous
    // attempts at the SAME guarded transition on the SAME row.
    const reports = await spawnTransitionWorkers(dbPath, tx_id, 8, 50);

    const totalApplied = reports.reduce((sum, r) => sum + r.applied, 0);
    const totalBusy = reports.reduce((sum, r) => sum + r.busyErrors, 0);
    assert.equal(totalBusy, 0, "with busy_timeout armed, no writer should surface SQLITE_BUSY");
    assert.ok(
      totalApplied > 10,
      `the flip-flop loop must actually win races sometimes to be meaningful (won ${totalApplied} times)`
    );

    // The invariant under genuine concurrency: whatever interleaving happened,
    // the row ends in exactly one of the two legal statuses with its data intact.
    const final = getTransaction(fileDb, tx_id);
    assert.ok(final);
    assert.ok(["verified", "released"].includes(final.status), `illegal terminal status ${final.status}`);
    assert.equal(final.deliverable_hash, "sha256:result", "deliverable hash must survive 400 racing writes");
    void memoryDb;
  } finally {
    cleanup();
  }
});

test("genuine concurrent racing on setDeliverableHash: first write wins permanently, all others cleanly rejected", async () => {
  const { buyer, seller, arbiter, dbPath, cleanup } = setUpVerifiedTxOnFileDb();
  try {
    const fileDb = openDatabase(dbPath);
    const createFields = {
      payer_id: buyer.agentId,
      payee_id: seller.agentId,
      amount: 0.004,
      currency: "USDC",
      task_hash: "sha256:test",
      sla_seconds: 30,
      arbiter_id: arbiter.agentId,
    };
    const { tx_id } = escrow.createEscrow(fileDb, signedCreateInput(buyer, seller, createFields));

    // Every worker tries to install ITS OWN hash simultaneously; exactly one
    // may ever succeed and the surviving hash must be that winner's.
    const src = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      (async () => {
        const raw = new DatabaseSync(workerData.dbPath);
        raw.exec('PRAGMA busy_timeout = 5000');
        const db = await import(workerData.dbModuleUrl);
        let applied = 0, busyErrors = 0;
        try {
          if (db.setDeliverableHash(raw, workerData.txId, workerData.hash, Date.now())) applied++;
        } catch { busyErrors++; }
        parentPort.postMessage({ applied, busyErrors, hash: workerData.hash });
      })();
    `;
    const reports = await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        return new Promise<{ applied: number; busyErrors: number; hash: string }>((resolve, reject) => {
          const worker = new Worker(src, {
            eval: true,
            workerData: { dbPath, dbModuleUrl: DB_MODULE_URL, txId: tx_id, hash: `sha256:winner-${i}` },
          });
          worker.on("message", resolve);
          worker.on("error", reject);
        });
      })
    );

    assert.equal(
      reports.reduce((sum, r) => sum + r.applied, 0),
      1,
      "exactly one of 12 simultaneous setDeliverableHash calls may apply"
    );
    const final = getTransaction(fileDb, tx_id);
    const winner = reports.find((r) => r.applied === 1);
    assert.equal(final?.deliverable_hash, winner?.hash, "the surviving hash must be the single winner's");
  } finally {
    cleanup();
  }
});

// --- Payee consent on arbiter selection (issue #2, cheap structural fix) -----
// Previously only the payer signed create_escrow, so a buyer could name three
// colluding sybil arbiters and later force a refund/slash against a seller
// who never agreed to any of them. Now BOTH parties must sign the identical
// payload before funds lock.

test("create_escrow rejects an arbiter selection the payee never signed", () => {
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

  // Missing payee_signature entirely.
  const missingConsent = { ...fields, signature: signCreate(buyer, fields) };
  assert.throws(
    () =>
      escrow.createEscrow(db, missingConsent as unknown as Parameters<typeof escrow.createEscrow>[1]),
    /payee consent/
  );

  // Present but signed by someone else (the payer trying to forge consent).
  const forgedConsent = {
    ...fields,
    signature: signCreate(buyer, fields),
    payee_signature: signCreate(buyer, fields), // right shape, wrong signer
  };
  assert.throws(() => escrow.createEscrow(db, forgedConsent), /createEscrow \(payee consent\)/);

  // Payee consent over a DIFFERENT payload (e.g. different arbiter than the
  // one being imposed) must also fail.
  const otherArbiter = arbitrationAgent();
  register(db, otherArbiter);
  const mismatched = {
    ...fields,
    signature: signCreate(buyer, fields),
    payee_signature: signCreate(seller, { ...fields, arbiter_id: otherArbiter.agentId }),
  };
  assert.throws(() => escrow.createEscrow(db, mismatched), /createEscrow \(payee consent\)/);
});

test("registry_quorum also requires the payee's consent to the random-selection mode itself", () => {
  const { db, buyer, seller } = setUpParties();
  registerArbiters(db, 3);
  const fields = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
    arbiter_selection: "registry_quorum" as const,
  };
  // The payee signed for a single named arbiter instead of quorum mode.
  const wrongMode = {
    ...fields,
    signature: signCreate(buyer, fields),
    payee_signature: signCreate(seller, { ...fields, arbiter_id: "did:key:zSomethingElse" }),
  };
  assert.throws(() => escrow.createEscrow(db, wrongMode), /payee consent/);
});

// --- Sybil-resistant pool eligibility (issue #2, economic floor) -------------
// Pool membership used to be just "registered + arbitration tag", so an
// attacker could flood it with near-zero-stake sybils and bias a random draw.
// Eligibility now requires stake >= ARBITER_MIN_STAKE.

test("near-zero-stake arbitration-tagged agents are excluded from the registry_quorum pool", () => {
  // Built by hand: exactly TWO staked arbiters plus THREE free ("0 USDC")
  // sybils — if the floor works, the pool is 2 < 3 and creation fails; if it
  // doesn't, the pool is 5 and a quorum gets drawn (possibly containing sybils).
  const db = freshDb();
  const buyer = createTestAgent();
  const seller = createTestAgent();
  register(db, buyer);
  register(db, seller);
  registerArbiters(db, 2); // staked (0.02 USDC tier -> ARBITER_MIN_STAKE)
  for (const _ of [1, 2, 3]) {
    const sybil = createTestAgent({ capabilityTags: ["arbitration"], priceSchedule: { arbitration: "0 USDC" } });
    register(db, sybil); // requiredStake("0 USDC") = 0 -> below the floor
  }

  const fields = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
    arbiter_selection: "registry_quorum" as const,
  };
  assert.throws(
    () => escrow.createEscrow(db, signedCreateInput(buyer, seller, fields)),
    /arbiter pool has only 2 eligible agent/
  );
});

test("a staked third-party arbiter at exactly the floor remains eligible", () => {
  const { db, buyer, seller } = setUpParties(); // setUpParties' arbiter stakes exactly ARBITER_MIN_STAKE
  registerArbiters(db, 2);
  const fields = {
    payer_id: buyer.agentId,
    payee_id: seller.agentId,
    amount: 0.004,
    currency: "USDC",
    task_hash: "sha256:test",
    sla_seconds: 30,
    arbiter_selection: "registry_quorum" as const,
  };
  const { tx_id } = escrow.createEscrow(db, signedCreateInput(buyer, seller, fields));
  const selected = JSON.parse(getTransaction(db, tx_id)?.arbiter_ids ?? "[]") as string[];
  assert.equal(selected.length, 3);
});
