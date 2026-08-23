// The single-writer lock from project-docs/serverless-deployment-guide.md
// (issue #9 — "the hard part"): guarantees only one scale-to-zero instance
// is ever mid-transaction against the shared SQLite file at a time, since
// Litestream (deploy/litestream/) replicates one writer's changes but does
// NOT arbitrate multiple simultaneous writers itself.
//
// Built entirely against the ConditionalStore interface (conditional-store.ts),
// not any specific backend — R2ConditionalStore (production, real R2) and
// LocalFileConditionalStore/InMemoryConditionalStore (test-only, see those
// files) are interchangeable here. The algorithm below is the actual thing
// being proven by test/distributed-lock.test.ts; the backend is not.
//
// Design, and why: R2 has no conditional DELETE (verified against
// developers.cloudflare.com/r2/api/s3/api/, 2026-08-23 — PutObject supports
// If-Match/If-None-Match, DeleteObject supports neither). So "release" here
// is a conditional PUT of a {status:"released"} marker, not a delete — the
// lock object is never actually removed, just overwritten, which is also
// exactly the mechanism a TTL-based steal needs anyway (both release and
// steal are "conditionally overwrite the current record").

export interface LockRecord {
  holderId: string;
  expiresAt: number; // ms epoch — this holder's claim is only valid until this instant
  status: "held" | "released";
}

export interface AcquireLockOptions {
  /** Identifies the caller attempting to acquire — surfaced back to a
   * competitor that loses the race, purely for operator-facing logging. */
  holderId: string;
  /** How long this holder's claim is valid before another caller may steal
   * it outright, whether or not this holder crashed. Choose this longer
   * than the longest expected transaction, and short enough that a real
   * crash doesn't wedge the system for an unreasonable window. */
  ttlMs: number;
  now?: () => number;
}

export type AcquireLockResult =
  | { acquired: true; etag: string }
  | { acquired: false; reason: "held"; holder: string; retryAfterMs: number }
  /** Lost a race against a concurrent claimant during THIS attempt — not
   * the same as "held": the lock may already be free again by the time the
   * caller retries. Distinguished from "held" so a retrying caller can back
   * off less aggressively than when a specific holder is genuinely mid-TTL. */
  | { acquired: false; reason: "contended" };

export async function acquireLock(
  store: import("./conditional-store.js").ConditionalStore,
  key: string,
  opts: AcquireLockOptions
): Promise<AcquireLockResult> {
  const now = (opts.now ?? Date.now)();
  const record: LockRecord = { holderId: opts.holderId, expiresAt: now + opts.ttlMs, status: "held" };
  const serialized = JSON.stringify(record);

  const existing = await store.get(key);
  if (!existing) {
    const created = await store.putIfAbsent(key, serialized);
    if (created.outcome === "written") return { acquired: true, etag: created.etag };
    // Someone else created it between our get() and putIfAbsent() — fall
    // through to the steal-if-expired path below against fresh state.
  }

  const current = existing ?? (await store.get(key));
  if (!current) {
    // Existed a moment ago (the putIfAbsent conflict above) but is gone
    // again now — vanishingly unlikely for a real store, but not our
    // problem to resolve: tell the caller to just retry.
    return { acquired: false, reason: "contended" };
  }

  let parsed: LockRecord;
  try {
    parsed = JSON.parse(current.value) as LockRecord;
  } catch {
    // A corrupt record is not this function's job to repair — treat like
    // losing a race so the caller's normal retry path handles it.
    return { acquired: false, reason: "contended" };
  }

  const isReclaimable = parsed.status === "released" || parsed.expiresAt <= now;
  if (!isReclaimable) {
    return { acquired: false, reason: "held", holder: parsed.holderId, retryAfterMs: parsed.expiresAt - now };
  }

  const stolen = await store.putIfMatch(key, serialized, current.etag);
  if (stolen.outcome === "written") return { acquired: true, etag: stolen.etag };
  return { acquired: false, reason: "contended" };
}

/** Best-effort. If this fails, it's because the lock already expired and
 * was stolen by someone else — not an error, since that's the exact
 * outcome release was trying to bring about anyway. */
export async function releaseLock(
  store: import("./conditional-store.js").ConditionalStore,
  key: string,
  holderId: string,
  etag: string
): Promise<void> {
  const record: LockRecord = { holderId, expiresAt: 0, status: "released" };
  await store.putIfMatch(key, JSON.stringify(record), etag);
}

export interface AcquireLockWithRetryOptions extends AcquireLockOptions {
  maxWaitMs: number;
  retryIntervalMs: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Polls acquireLock until it succeeds or maxWaitMs elapses. The scale-to-zero
 * wrapper (issue #10) is the intended caller — a real invocation should give
 * up and fail the request rather than wait indefinitely. */
export async function acquireLockWithRetry(
  store: import("./conditional-store.js").ConditionalStore,
  key: string,
  opts: AcquireLockWithRetryOptions
): Promise<AcquireLockResult> {
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.maxWaitMs;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    const result = await acquireLock(store, key, opts);
    if (result.acquired) return result;
    if (now() >= deadline) return result;
    await sleep(opts.retryIntervalMs);
  }
}
