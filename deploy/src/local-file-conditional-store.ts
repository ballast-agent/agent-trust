// A ConditionalStore backed by real files, used ONLY to prove
// distributed-lock.ts's algorithm under genuine multi-process OS-level
// contention (see test/distributed-lock.test.ts's child-process race test)
// — mirroring exactly why escrow-server's concurrency tests moved from
// :memory: SQLite to a real file-backed db (see that file's "genuine
// concurrent racing" tests). This is NOT a production store; R2ConditionalStore
// is. Never import this from anything other than a test.
//
// putIfAbsent needs no extra synchronization: exclusive file creation
// (open with the 'wx' flag) is a real atomic OS syscall on both POSIX and
// Windows, which is exactly R2's own PutObject-with-If-None-Match
// guarantee. putIfMatch has no equivalently simple atomic primitive for
// "compare current content, then conditionally overwrite" across
// independent OS processes, so it's guarded by a short-lived sidecar lock
// file (<key>.mutex, itself created via the same atomic 'wx' primitive) —
// an implementation detail of this TEST DOUBLE only. distributed-lock.ts
// never sees this; it only calls the ConditionalStore interface, so this
// internal mutex can't leak into or weaken what the test actually proves
// about distributed-lock.ts's own algorithm.

import { openSync, closeSync, writeSync, readFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { ConditionalStore, ConditionalWriteResult, StoredObject } from "./conditional-store.js";

function contentEtag(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function withSidecarMutex<T>(path: string, fn: () => T): Promise<T> {
  const mutexPath = `${path}.mutex`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      closeSync(openSync(mutexPath, "wx"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) throw new Error(`timed out waiting for sidecar mutex: ${mutexPath}`);
      await sleep(5);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(mutexPath, { force: true });
  }
}

export class LocalFileConditionalStore implements ConditionalStore {
  constructor(private readonly baseDir: string) {}

  private pathFor(key: string): string {
    return `${this.baseDir}/${encodeURIComponent(key)}`;
  }

  async get(key: string): Promise<StoredObject | undefined> {
    const path = this.pathFor(key);
    if (!existsSync(path)) return undefined;
    try {
      const value = readFileSync(path, "utf8");
      return { value, etag: contentEtag(value) };
    } catch {
      return undefined;
    }
  }

  async putIfAbsent(key: string, value: string): Promise<ConditionalWriteResult> {
    const path = this.pathFor(key);
    try {
      const fd = openSync(path, "wx"); // atomic create-only — the real primitive being proven
      writeSync(fd, value, null, "utf8");
      closeSync(fd);
      return { outcome: "written", etag: contentEtag(value) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return { outcome: "conflict" };
      throw err;
    }
  }

  async putIfMatch(key: string, value: string, expectedEtag: string): Promise<ConditionalWriteResult> {
    const path = this.pathFor(key);
    return withSidecarMutex(path, () => {
      if (!existsSync(path)) return { outcome: "conflict" };
      const current = readFileSync(path, "utf8");
      if (contentEtag(current) !== expectedEtag) return { outcome: "conflict" };
      const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
      const fd = openSync(tmpPath, "w");
      writeSync(fd, value, null, "utf8");
      closeSync(fd);
      renameSync(tmpPath, path); // atomic swap on the same filesystem
      return { outcome: "written", etag: contentEtag(value) };
    });
  }
}
