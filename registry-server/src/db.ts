// SQLite backing store per agent-trust-layer-spec.md §1 and §6 ("in-memory
// or SQLite backing store"). Uses node:sqlite (built into Node 22.5+) rather
// than adding a database dependency — ARCHITECTURE_GUARDRAILS.md dependency
// discipline: prefer platform capability before reaching for a package.

import { DatabaseSync } from "node:sqlite";

export type TransactionStatus =
  | "pending"
  | "escrowed"
  | "verified"
  | "released"
  | "disputed"
  | "refunded"
  | "slashed";

export const SETTLED_STATUSES: readonly TransactionStatus[] = ["released", "refunded", "slashed"];

export type ReviewOutcome = "satisfied" | "partial" | "failed";

export interface AgentRow {
  agent_id: string;
  manifest_url: string;
  wallet_address: string;
  stake_amount: number;
  capability_tags: string; // JSON array, cached from last verified manifest fetch
  price_schedule: string; // JSON object, cached from last verified manifest fetch
  // Cached from the same verified manifest fetch as capability_tags/price_schedule.
  // Nullable only for rows inserted before this column existed — get_manifest
  // treats a null here as cache-miss-worthy rather than fabricating a value
  // (see getManifest's isStale check in tools.ts).
  sla_seconds: number | null;
  manifest_signature: string | null;
  principal_contact: string | null;
  principal_verified: 0 | 1;
  manifest_fetched_at: number;
  created_at: number;
  last_active: number;
}

export interface TransactionRow {
  tx_id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  currency: string;
  task_hash: string;
  deliverable_hash: string | null;
  status: TransactionStatus;
  escrow_deadline: number | null;
  // Pre-selected at escrow creation per agent-trust-layer-spec.md §4 — "not
  // after-the-fact, so neither side can shop for a friendly arbiter." JSON
  // array of agent_ids: length 1 for a single arbiter, length 3 for the
  // spec's "randomly-selected quorum of 3." "[]" for transactions created
  // before escrow-server existed (Registry-only test transactions).
  arbiter_ids: string;
  // Optional JSON blob {"outcome":"satisfied","notes":string|null,"signature":base64}
  // captured by escrow-server's create_escrow: the payer's advance signature
  // over a satisfied review ({reviewer_id, outcome, notes, task_hash}),
  // redeemed by escrow-server's sweep_auto_release ONLY if the transaction
  // actually resolves through that automatic path. Null when not provided.
  pre_signed_review: string | null;
  // For registry_quorum-selected arbiters: hex sha256 seed over inputs
  // neither transacting party controls alone (server-generated tx_id,
  // server clock at creation, registry-wide agent count). Stored so the
  // quorum selection is auditable/recomputable against the arbitration
  // pool. Null for single-arbiter escrows.
  arbiter_seed: string | null;
  created_at: number;
  // Set when submitDeliverable moves status to 'verified' — the clock the
  // Escrow Layer's auto-release grace window (spec §3 step 5) counts from.
  delivered_at: number | null;
  resolved_at: number | null;
}

export interface ReviewRow {
  tx_id: string;
  reviewer_id: string;
  outcome: ReviewOutcome;
  notes: string | null;
  signature: string;
  signed_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  manifest_url TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  stake_amount REAL NOT NULL,
  capability_tags TEXT NOT NULL,
  price_schedule TEXT NOT NULL,
  sla_seconds REAL,
  manifest_signature TEXT,
  principal_contact TEXT,
  principal_verified INTEGER NOT NULL DEFAULT 0,
  manifest_fetched_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_active INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  tx_id TEXT PRIMARY KEY,
  payer_id TEXT NOT NULL REFERENCES agents(agent_id),
  payee_id TEXT NOT NULL REFERENCES agents(agent_id),
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  task_hash TEXT NOT NULL,
  deliverable_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','escrowed','verified','released','disputed','refunded','slashed')),
  escrow_deadline INTEGER,
  arbiter_ids TEXT NOT NULL DEFAULT '[]',
  pre_signed_review TEXT,
  arbiter_seed TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS reviews (
  tx_id TEXT NOT NULL REFERENCES transactions(tx_id),
  reviewer_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('satisfied','partial','failed')),
  notes TEXT,
  signature TEXT NOT NULL,
  signed_at INTEGER NOT NULL,
  PRIMARY KEY (tx_id, reviewer_id)
);

CREATE INDEX IF NOT EXISTS idx_transactions_payee ON transactions(payee_id);
CREATE INDEX IF NOT EXISTS idx_reviews_tx ON reviews(tx_id);
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  // WAL mode is a hard requirement for Litestream replication (it streams
  // the WAL file; a rollback-journal db gives it nothing to follow — see
  // project-docs/serverless-deployment-guide.md) and is also SQLite's own
  // recommendation for this project's actual access pattern: two processes
  // sharing one file. Silently stays "memory" for :memory: connections
  // (SQLite doesn't support WAL there) — safe no-op for every in-memory test.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  // Additive migrations for database files created before a column existed.
  // CREATE TABLE IF NOT EXISTS can't add columns to an existing table, and
  // both services share one file that may predate the column (DATA_AND_STATE.md:
  // destructive changes need a plan; additive ones just need a guard).
  const transactionColumns = (
    db.prepare("PRAGMA table_info(transactions)").all() as { name: string }[]
  ).map((column) => column.name);
  for (const addedColumn of ["pre_signed_review", "arbiter_seed"]) {
    if (!transactionColumns.includes(addedColumn)) {
      db.exec(`ALTER TABLE transactions ADD COLUMN ${addedColumn} TEXT;`);
    }
  }
  const agentColumns = (
    db.prepare("PRAGMA table_info(agents)").all() as { name: string }[]
  ).map((column) => column.name);
  if (!agentColumns.includes("sla_seconds")) {
    db.exec(`ALTER TABLE agents ADD COLUMN sla_seconds REAL;`);
  }
  if (!agentColumns.includes("manifest_signature")) {
    db.exec(`ALTER TABLE agents ADD COLUMN manifest_signature TEXT;`);
  }
  return db;
}

export function insertAgent(db: DatabaseSync, row: AgentRow): void {
  db.prepare(
    `INSERT INTO agents (agent_id, manifest_url, wallet_address, stake_amount, capability_tags,
       price_schedule, sla_seconds, manifest_signature, principal_contact, principal_verified,
       manifest_fetched_at, created_at, last_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.agent_id,
    row.manifest_url,
    row.wallet_address,
    row.stake_amount,
    row.capability_tags,
    row.price_schedule,
    row.sla_seconds,
    row.manifest_signature,
    row.principal_contact,
    row.principal_verified,
    row.manifest_fetched_at,
    row.created_at,
    row.last_active
  );
}

export function getAgent(db: DatabaseSync, agentId: string): AgentRow | undefined {
  return db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as AgentRow | undefined;
}

export function updateAgentManifestCache(
  db: DatabaseSync,
  agentId: string,
  capabilityTags: string,
  priceSchedule: string,
  slaSeconds: number,
  manifestSignature: string,
  fetchedAt: number
): void {
  db.prepare(
    `UPDATE agents SET capability_tags = ?, price_schedule = ?, sla_seconds = ?,
       manifest_signature = ?, manifest_fetched_at = ? WHERE agent_id = ?`
  ).run(capabilityTags, priceSchedule, slaSeconds, manifestSignature, fetchedAt, agentId);
}

export function touchLastActive(db: DatabaseSync, agentId: string, at: number): void {
  db.prepare("UPDATE agents SET last_active = ? WHERE agent_id = ?").run(at, agentId);
}

export function listAgentsByCapability(db: DatabaseSync, capabilityTag: string): AgentRow[] {
  const agents = db.prepare("SELECT * FROM agents").all() as unknown as AgentRow[];
  return agents.filter((agent) => {
    const tags = JSON.parse(agent.capability_tags) as string[];
    return tags.includes(capabilityTag);
  });
}

/** Registry-wide agent count — one of the inputs escrow-server hashes into
 * its arbiter-quorum seed, since any participant's registrations shift it
 * and neither transacting party controls it alone. */
export function countAgents(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM agents").get() as { count: number };
  return row.count;
}

export function reduceStake(db: DatabaseSync, agentId: string, amount: number): void {
  db.prepare(
    "UPDATE agents SET stake_amount = MAX(0, stake_amount - ?) WHERE agent_id = ?"
  ).run(amount, agentId);
}

export function getTransaction(db: DatabaseSync, txId: string): TransactionRow | undefined {
  return db.prepare("SELECT * FROM transactions WHERE tx_id = ?").get(txId) as
    | TransactionRow
    | undefined;
}

export function insertTransaction(db: DatabaseSync, row: TransactionRow): void {
  db.prepare(
    `INSERT INTO transactions (tx_id, payer_id, payee_id, amount, currency, task_hash,
       deliverable_hash, status, escrow_deadline, arbiter_ids, pre_signed_review,
       arbiter_seed, created_at, delivered_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.tx_id,
    row.payer_id,
    row.payee_id,
    row.amount,
    row.currency,
    row.task_hash,
    row.deliverable_hash,
    row.status,
    row.escrow_deadline,
    row.arbiter_ids,
    row.pre_signed_review,
    row.arbiter_seed,
    row.created_at,
    row.delivered_at,
    row.resolved_at
  );
}

export function hasReview(db: DatabaseSync, txId: string, reviewerId: string): boolean {
  return db
    .prepare("SELECT 1 FROM reviews WHERE tx_id = ? AND reviewer_id = ?")
    .get(txId, reviewerId) !== undefined;
}

/**
 * Sets the deliverable hash and transitions escrowed -> verified in one
 * atomic statement, rather than two separate reads-then-writes. Returns
 * false (no-op) if the transaction wasn't in 'escrowed' status at the
 * moment of the write — e.g. two concurrent submit_deliverable calls for
 * the same tx_id, where without this guard both could pass a JS-level
 * status check (reading the same stale 'escrowed' row) and both write,
 * silently letting the second call overwrite the first's hash.
 */
export function setDeliverableHash(
  db: DatabaseSync,
  txId: string,
  deliverableHash: string,
  deliveredAt: number
): boolean {
  const result = db
    .prepare(
      `UPDATE transactions SET deliverable_hash = ?, delivered_at = ?, status = 'verified'
       WHERE tx_id = ? AND status = 'escrowed'`
    )
    .run(deliverableHash, deliveredAt, txId);
  return result.changes > 0;
}

export function listVerifiedTransactionsOlderThan(
  db: DatabaseSync,
  deliveredBeforeMs: number
): TransactionRow[] {
  return db
    .prepare(
      `SELECT * FROM transactions WHERE status = 'verified' AND delivered_at IS NOT NULL AND delivered_at < ?`
    )
    .all(deliveredBeforeMs) as unknown as TransactionRow[];
}

/**
 * Transitions a transaction's status, but only if it's currently one of
 * `fromStatuses` — checked and applied in one atomic UPDATE, not a
 * separate read-then-write. Returns whether the transition actually
 * happened; callers must treat `false` as "someone else already moved
 * this transaction," not silently proceed as if their write landed.
 *
 * This is the fix for a real concurrency gap: two concurrent tool calls
 * (e.g. two confirm_release calls for the same tx_id) could previously
 * both read the same pre-transition status via getTransaction, both pass
 * their JS-level `if (tx.status !== ...)` check, and both apply their
 * write and side effects (e.g. both call submit_review) before either
 * one's UPDATE was visible to the other. Guarding the status in the
 * UPDATE's WHERE clause closes that window: only the first writer's
 * statement can match, the second gets changes=0 and must be rejected by
 * its caller instead of proceeding.
 */
export function setTransactionStatus(
  db: DatabaseSync,
  txId: string,
  fromStatuses: readonly TransactionStatus[],
  toStatus: TransactionStatus,
  resolvedAt: number | null
): boolean {
  const placeholders = fromStatuses.map(() => "?").join(",");
  const result = db
    .prepare(
      `UPDATE transactions SET status = ?, resolved_at = ? WHERE tx_id = ? AND status IN (${placeholders})`
    )
    .run(toStatus, resolvedAt, txId, ...fromStatuses);
  return result.changes > 0;
}

export function insertReview(db: DatabaseSync, row: ReviewRow): void {
  db.prepare(
    `INSERT INTO reviews (tx_id, reviewer_id, outcome, notes, signature, signed_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(row.tx_id, row.reviewer_id, row.outcome, row.notes, row.signature, row.signed_at);
}

/**
 * All reviews ABOUT an agent, symmetric across both seats of a transaction:
 * as payee (the payer's review of work received) and as payer (the payee's
 * review of the buyer, e.g. confirm_release's optional payee_review).
 *
 * A review row always judges its author's *counterparty* — the seat the
 * reviewer occupied determines who is being scored — so "about me" is
 * exactly "on a tx involving me, authored by someone else". The
 * reviewer_id != ? clause enforces the other half of that: your own writes
 * score your counterparty, never you (before this query covered both
 * seats, such rows could double-count toward the author's own score).
 * Without the payer-side half, buyers accumulated no reputation at all and
 * sellers had no signal to evaluate them — see trust-evaluation-guide.md §2.
 */
export function listReviewsForAgent(db: DatabaseSync, agentId: string): (ReviewRow & { amount: number })[] {
  return db
    .prepare(
      `SELECT reviews.*, transactions.amount as amount
       FROM reviews
       JOIN transactions ON transactions.tx_id = reviews.tx_id
       WHERE (transactions.payee_id = ? OR transactions.payer_id = ?)
         AND reviews.reviewer_id != ?`
    )
    .all(agentId, agentId, agentId) as unknown as (ReviewRow & { amount: number })[];
}

export function countTransactionsForAgent(db: DatabaseSync, agentId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM transactions
       WHERE (payer_id = ? OR payee_id = ?) AND status IN ('released','refunded','slashed')`
    )
    .get(agentId, agentId) as { count: number };
  return row.count;
}

export function countDisputesForAgent(db: DatabaseSync, agentId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM transactions
       WHERE (payer_id = ? OR payee_id = ?) AND status = 'disputed'`
    )
    .get(agentId, agentId) as { count: number };
  return row.count;
}
