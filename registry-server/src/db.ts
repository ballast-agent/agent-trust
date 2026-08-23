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
  db.exec(SCHEMA);
  return db;
}

export function insertAgent(db: DatabaseSync, row: AgentRow): void {
  db.prepare(
    `INSERT INTO agents (agent_id, manifest_url, wallet_address, stake_amount, capability_tags,
       price_schedule, principal_contact, principal_verified, manifest_fetched_at, created_at, last_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.agent_id,
    row.manifest_url,
    row.wallet_address,
    row.stake_amount,
    row.capability_tags,
    row.price_schedule,
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
  fetchedAt: number
): void {
  db.prepare(
    `UPDATE agents SET capability_tags = ?, price_schedule = ?, manifest_fetched_at = ? WHERE agent_id = ?`
  ).run(capabilityTags, priceSchedule, fetchedAt, agentId);
}

export function touchLastActive(db: DatabaseSync, agentId: string, at: number): void {
  db.prepare("UPDATE agents SET last_active = ? WHERE agent_id = ?").run(at, agentId);
}

export function listAgentsByCapability(db: DatabaseSync, capabilityTag: string): AgentRow[] {
  return db
    .prepare(`SELECT * FROM agents WHERE capability_tags LIKE ?`)
    .all(`%"${capabilityTag}"%`) as unknown as AgentRow[];
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
       deliverable_hash, status, escrow_deadline, arbiter_ids, created_at, delivered_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    row.created_at,
    row.delivered_at,
    row.resolved_at
  );
}

export function setDeliverableHash(db: DatabaseSync, txId: string, deliverableHash: string): void {
  db.prepare(
    "UPDATE transactions SET deliverable_hash = ?, delivered_at = ? WHERE tx_id = ?"
  ).run(deliverableHash, Date.now(), txId);
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

export function setTransactionStatus(
  db: DatabaseSync,
  txId: string,
  status: TransactionStatus,
  resolvedAt: number | null
): void {
  db.prepare("UPDATE transactions SET status = ?, resolved_at = ? WHERE tx_id = ?").run(
    status,
    resolvedAt,
    txId
  );
}

export function insertReview(db: DatabaseSync, row: ReviewRow): void {
  db.prepare(
    `INSERT INTO reviews (tx_id, reviewer_id, outcome, notes, signature, signed_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(row.tx_id, row.reviewer_id, row.outcome, row.notes, row.signature, row.signed_at);
}

export function listReviewsForAgent(db: DatabaseSync, agentId: string): (ReviewRow & { amount: number })[] {
  return db
    .prepare(
      `SELECT reviews.*, transactions.amount as amount
       FROM reviews
       JOIN transactions ON transactions.tx_id = reviews.tx_id
       WHERE transactions.payee_id = ?`
    )
    .all(agentId) as unknown as (ReviewRow & { amount: number })[];
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
