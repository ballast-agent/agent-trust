// The minimal storage interface distributed-lock.ts needs — deliberately
// shaped to match exactly what Cloudflare R2's S3-compatible API actually
// supports (verified against developers.cloudflare.com/r2/api/s3/api/,
// 2026-08-23): PutObject supports If-None-Match/If-Match conditional
// headers, but DeleteObject supports NEITHER — R2 has no conditional
// delete. That's why this interface has no `deleteIfMatch`: the lock
// design (distributed-lock.ts) never needs one, specifically because of
// this constraint — "release" is a conditional PUT of a released marker,
// not a delete.
//
// Two implementations exist: InMemoryConditionalStore (fast, single-process,
// for exercising the CAS algorithm's own logic) and LocalFileConditionalStore
// (real OS-level atomicity via exclusive file creation, for genuine
// multi-process race tests — mirroring why escrow-server's concurrency
// tests moved from :memory: to real file-backed SQLite). The production
// implementation (R2ConditionalStore, using the real S3 API) is a separate
// file specifically so these test doubles never import the AWS SDK.

export interface StoredObject {
  value: string;
  /** Opaque version token — maps directly to S3/R2's ETag. Callers must
   * treat this as opaque; never parse or compare it structurally. */
  etag: string;
}

export type ConditionalWriteResult =
  | { outcome: "written"; etag: string }
  /** The precondition failed — someone else won the race. Maps directly to
   * R2/S3's real HTTP 412 Precondition Failed. */
  | { outcome: "conflict" };

export interface ConditionalStore {
  get(key: string): Promise<StoredObject | undefined>;
  /** Create-only write — maps to R2 PutObject with `If-None-Match: *`.
   * Conflicts if the key already exists. */
  putIfAbsent(key: string, value: string): Promise<ConditionalWriteResult>;
  /** Overwrite only if the current object's etag matches — maps to R2
   * PutObject with `If-Match: <etag>`. Conflicts if the key is missing OR
   * its etag has changed since the caller last read it. */
  putIfMatch(key: string, value: string, expectedEtag: string): Promise<ConditionalWriteResult>;
}

/**
 * In-memory ConditionalStore for exercising distributed-lock.ts's own CAS
 * logic cheaply. Deliberately inserts a real await between "check" and
 * "write" in every method (`yieldToEventLoop()`) — a naive synchronous Map
 * read-then-write would never actually interleave under `Promise.all`,
 * which would prove nothing about race safety (the same trap the project's
 * SQLite concurrency tests specifically had to avoid — see
 * escrow-server/test/escrow.test.ts's "genuine concurrent racing" tests).
 * The artificial gap here recreates the real network round-trip a
 * networked store always has between reading current state and issuing a
 * conditional write.
 */
export class InMemoryConditionalStore implements ConditionalStore {
  private readonly objects = new Map<string, StoredObject>();
  private etagCounter = 0;

  private yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  private nextEtag(): string {
    this.etagCounter += 1;
    return `etag-${this.etagCounter}`;
  }

  async get(key: string): Promise<StoredObject | undefined> {
    await this.yieldToEventLoop();
    const current = this.objects.get(key);
    return current ? { ...current } : undefined;
  }

  async putIfAbsent(key: string, value: string): Promise<ConditionalWriteResult> {
    const existed = this.objects.has(key);
    await this.yieldToEventLoop(); // the race window: another call can land here
    if (this.objects.has(key) || existed) return { outcome: "conflict" };
    const etag = this.nextEtag();
    this.objects.set(key, { value, etag });
    return { outcome: "written", etag };
  }

  async putIfMatch(key: string, value: string, expectedEtag: string): Promise<ConditionalWriteResult> {
    const before = this.objects.get(key);
    await this.yieldToEventLoop(); // the race window
    const current = this.objects.get(key);
    if (!current || current.etag !== expectedEtag || before?.etag !== expectedEtag) {
      return { outcome: "conflict" };
    }
    const etag = this.nextEtag();
    this.objects.set(key, { value, etag });
    return { outcome: "written", etag };
  }
}
