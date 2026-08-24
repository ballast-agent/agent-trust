import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryConditionalStore } from "../src/conditional-store.js";
import { LocalFileConditionalStore } from "../src/local-file-conditional-store.js";
import { acquireLock, releaseLock, acquireLockWithRetry } from "../src/distributed-lock.js";

test("acquireLock: a free lock is acquired, and the same store then reports it held", async () => {
  const store = new InMemoryConditionalStore();
  const result = await acquireLock(store, "lock", { holderId: "a", ttlMs: 10_000 });
  assert.equal(result.acquired, true);

  const second = await acquireLock(store, "lock", { holderId: "b", ttlMs: 10_000 });
  assert.equal(second.acquired, false);
  if (!second.acquired) {
    assert.equal(second.reason, "held");
    assert.equal(second.holder, "a");
  }
});

test("releaseLock lets the next caller acquire immediately, before the TTL would otherwise expire", async () => {
  const store = new InMemoryConditionalStore();
  const first = await acquireLock(store, "lock", { holderId: "a", ttlMs: 60_000 });
  assert.ok(first.acquired);
  if (!first.acquired) return;

  await releaseLock(store, "lock", "a", first.etag);

  const second = await acquireLock(store, "lock", { holderId: "b", ttlMs: 60_000 });
  assert.equal(second.acquired, true, "release must free the lock well before its TTL, not just at TTL expiry");
});

test("a lock held past its TTL is reclaimable by a new caller", async () => {
  let now = 1_000_000;
  const clock = () => now;
  const store = new InMemoryConditionalStore();

  const first = await acquireLock(store, "lock", { holderId: "a", ttlMs: 5_000, now: clock });
  assert.ok(first.acquired);

  // Still within TTL — must NOT be reclaimable yet.
  now += 4_000;
  const tooSoon = await acquireLock(store, "lock", { holderId: "b", ttlMs: 5_000, now: clock });
  assert.equal(tooSoon.acquired, false, "must not be reclaimable before the original TTL actually expires");

  // Past TTL now.
  now += 2_000;
  const reclaimed = await acquireLock(store, "lock", { holderId: "b", ttlMs: 5_000, now: clock });
  assert.equal(reclaimed.acquired, true, "must be reclaimable once the original holder's TTL has passed");
});

test("a simulated crash (holder never releases) does not permanently wedge the lock", async () => {
  let now = 2_000_000;
  const clock = () => now;
  const store = new InMemoryConditionalStore();

  const crashedHolder = await acquireLock(store, "lock", { holderId: "doomed-instance", ttlMs: 3_000, now: clock });
  assert.ok(crashedHolder.acquired);
  // ...and then it just vanishes. No releaseLock call, ever.

  now += 10_000; // well past the TTL
  const survivor = await acquireLock(store, "lock", { holderId: "fresh-instance", ttlMs: 3_000, now: clock });
  assert.equal(survivor.acquired, true, "the system must recover from a crashed holder via TTL, not wedge forever");
});

test("acquireLockWithRetry backs off and eventually succeeds once the holder releases", async () => {
  const store = new InMemoryConditionalStore();
  const first = await acquireLock(store, "lock", { holderId: "a", ttlMs: 60_000 });
  assert.ok(first.acquired);
  if (!first.acquired) return;

  const sleeps: number[] = [];
  const retryPromise = acquireLockWithRetry(store, "lock", {
    holderId: "b",
    ttlMs: 60_000,
    maxWaitMs: 10_000,
    retryIntervalMs: 50,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 2) await releaseLock(store, "lock", "a", first.etag);
    },
  });

  const result = await retryPromise;
  assert.equal(result.acquired, true, "must eventually succeed once the lock actually frees");
  assert.ok(sleeps.length >= 2, "must have actually retried, not succeeded on the first attempt");
});

test("acquireLockWithRetry gives up after maxWaitMs if the lock never frees", async () => {
  let now = 0;
  const store = new InMemoryConditionalStore();
  const first = await acquireLock(store, "lock", { holderId: "a", ttlMs: 60_000, now: () => now });
  assert.ok(first.acquired);

  const result = await acquireLockWithRetry(store, "lock", {
    holderId: "b",
    ttlMs: 60_000,
    maxWaitMs: 200,
    retryIntervalMs: 50,
    now: () => now,
    sleep: async () => {
      now += 60; // advance the injected clock instead of sleeping for real
    },
  });

  assert.equal(result.acquired, false, "must give up rather than wait forever once maxWaitMs is exceeded");
});

test("many concurrent acquireLock calls on the SAME store race safely: exactly one wins", async () => {
  const store = new InMemoryConditionalStore();
  const contenderCount = 12;
  const results = await Promise.all(
    Array.from({ length: contenderCount }, (_, i) =>
      acquireLock(store, "lock", { holderId: `contender-${i}`, ttlMs: 60_000 })
    )
  );
  const winners = results.filter((r) => r.acquired);
  assert.equal(
    winners.length,
    1,
    `exactly one of ${contenderCount} concurrent same-process attempts must win, got ${winners.length}`
  );
});

// --- genuine multi-process race, mirroring escrow-server's proven pattern ---

const lockRaceChildPath = fileURLToPath(new URL("./lock-race-child.ts", import.meta.url));

interface ChildResult {
  result?: { acquired: boolean; reason?: string };
  error?: string;
}

function spawnLockRaceChild(baseDir: string, key: string, holderId: string, ttlMs: number): {
  ready: Promise<void>;
  result: Promise<ChildResult>;
  send: () => void;
} {
  const child: ChildProcess = fork(lockRaceChildPath, {
    cwd: new URL("..", import.meta.url),
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env,
      AGENTTRUST_LOCK_RACE_CHILD_CONFIG: JSON.stringify({ baseDir, key, holderId, ttlMs }),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));

  const ready = new Promise<void>((resolve, reject) => {
    child.on("message", (message: { type: string }) => {
      if (message.type === "ready") resolve();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`child exited early with code=${code} stderr=${stderr.trim()}`));
    });
  });

  const result = new Promise<ChildResult>((resolve, reject) => {
    child.on("message", (message: { type: string } & ChildResult) => {
      if (message.type === "result") resolve(message);
    });
    child.on("error", reject);
  });

  return { ready, result, send: () => child.send({ type: "go" }) };
}

test("genuine multi-process race: independent processes contend for the same lock via real files, exactly one wins", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "agenttrust-lock-race-"));
  try {
    const contenderCount = 6;
    const children = Array.from({ length: contenderCount }, (_, i) =>
      spawnLockRaceChild(baseDir, "primary-writer", `process-${i}`, 60_000)
    );

    await Promise.all(children.map((c) => c.ready));
    for (const c of children) c.send();

    const results = await Promise.all(children.map((c) => c.result));
    const winners = results.filter((r) => r.result?.acquired);
    const losers = results.filter((r) => r.result?.acquired === false);

    assert.equal(
      winners.length,
      1,
      `exactly one of ${contenderCount} independent OS processes must win the real file-backed race, got ${winners.length}: ${JSON.stringify(results)}`
    );
    assert.equal(losers.length, contenderCount - 1);
    for (const loser of losers) {
      assert.ok(
        loser.result?.reason === "held" || loser.result?.reason === "contended",
        `losers must be cleanly rejected via the lock protocol, not crash: ${JSON.stringify(loser)}`
      );
    }
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
