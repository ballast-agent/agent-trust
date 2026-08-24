# AgentTrust Deploy Tooling

Serverless deployment tooling per
[project-docs/serverless-deployment-guide.md](../project-docs/serverless-deployment-guide.md)
— issues [#8](https://github.com/loomweaver-agent/agent-trust/issues/8)
(Litestream replication) and
[#9](https://github.com/loomweaver-agent/agent-trust/issues/9) (the
single-writer distributed lock) of that design's 4-issue tracking list are
built here. Issues [#10](https://github.com/loomweaver-agent/agent-trust/issues/10)–[#11](https://github.com/loomweaver-agent/agent-trust/issues/11)
(the scale-to-zero compute wrapper and the HTTP/SSE MCP transport) are not
built here yet — the lock exists but nothing calls it as part of a real
request lifecycle until #10 wires it in.

## What's actually proven here vs. what still needs real R2 credentials

`npm run smoke-test:litestream` proves the replication **mechanism** end
to end — write to the shared db, Litestream streams it to a replica,
restore a fresh copy, confirm the data survived — using Litestream's local
`file` replica type. It needs **no cloud credentials** and runs on this
machine. It does not touch Cloudflare or R2 at all.

`litestream/litestream.yml` is the **production** config, targeting a real
R2 bucket via Litestream's `s3` replica type (R2 is S3-compatible). That
config has not been run against a real bucket — doing so requires an
actual Cloudflare account and R2 credentials, which this environment
doesn't have. The replica backend is genuinely interchangeable in
Litestream (that's the whole point of it supporting multiple replica
types), so the file-replica proof and the R2 config are the same
mechanism — but "the mechanism works" and "this exact bucket/credentials
combination works" are different claims. Verify the latter yourself once
you have real R2 access, ideally with the same restore-to-a-fresh-path
check this smoke test does.

## Setup

### 1. Install Litestream

Litestream is a standalone Go binary, not an npm package — download it
from the [releases page](https://github.com/benbjohnson/litestream/releases)
for your platform and put it on `PATH` (or point `LITESTREAM_BIN` at it
directly, see below). No package-manager listing was found for it on
Windows (checked winget) at the time this was written — a direct
zip/tarball download is the reliable path on every platform.

```bash
npm install
```

### 2. Run the smoke test (no credentials needed)

```bash
npm run smoke-test:litestream
```

If `litestream` isn't on `PATH`, point at it directly:

```bash
LITESTREAM_BIN=/path/to/litestream npm run smoke-test:litestream
```

Expected output ends with "Litestream replication mechanism verified end-to-end".

### 3. Set up the real R2 bucket (production)

1. Create an R2 bucket in the Cloudflare dashboard (or via `wrangler r2 bucket create`).
2. Create an R2 API token scoped to that bucket (Cloudflare dashboard → R2 → Manage API Tokens).
3. Set these environment variables wherever `litestream replicate` will actually run:

   | Variable | Where it comes from |
   |---|---|
   | `AGENTTRUST_DB_PATH` | Same path both `registry-server`/`escrow-server` use via `REGISTRY_DB_PATH` |
   | `LITESTREAM_R2_BUCKET` | The bucket name from step 1 |
   | `LITESTREAM_R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
   | `LITESTREAM_R2_ACCESS_KEY_ID` | From the API token in step 2 |
   | `LITESTREAM_R2_SECRET_ACCESS_KEY` | From the API token in step 2 |

4. Run Litestream alongside the two MCP servers, pointed at the shared db:

   ```bash
   litestream replicate -config deploy/litestream/litestream.yml
   ```

5. To restore (e.g. bootstrapping a fresh instance, per issue #10's
   scale-to-zero design):

   ```bash
   litestream restore -config deploy/litestream/litestream.yml -o /path/to/restored/shared.db "$AGENTTRUST_DB_PATH"
   ```

## Known Windows-only quirk (does not affect the actual data)

On Windows, `litestream restore` can exit non-zero with `Error: sync
restore output dir: sync <path>: Access is denied.` even though the
restored `.db` file itself is written correctly — this is Litestream
attempting to `fsync` the output directory's metadata after writing,
which Windows/NTFS doesn't support the way POSIX filesystems do. Verified
directly: the restored file's contents are correct despite the non-zero
exit code (see this package's smoke test, which checks the actual restored
data rather than trusting the exit code alone, and treats exactly this
error message as non-fatal). Real deployment targets (Fly Machines, per
issue #10's design) run Linux, so this specific quirk is a local
Windows-dev-loop wrinkle, not a production concern — but don't `set -e` /
fail a script purely on this command's exit code on Windows without also
checking the data.

## The distributed lock (issue #9)

Litestream (above) replicates one writer's changes — it does not arbitrate
multiple simultaneous writers. `src/distributed-lock.ts` is that
arbitration: a mutex over a `ConditionalStore` (`src/conditional-store.ts`),
implemented against the exact conditional-write semantics Cloudflare R2's
S3-compatible API actually supports (verified against
[developers.cloudflare.com/r2/api/s3/api/](https://developers.cloudflare.com/r2/api/s3/api/),
2026-08-23): `PutObject` supports `If-Match`/`If-None-Match`; `DeleteObject`
supports **neither**. That's why `releaseLock` overwrites the lock record
with a `released` marker via a conditional `PutObject` rather than deleting
it — R2 gives no conditional-delete primitive to build one on.

Run its tests:

```bash
npm test
```

8 tests, including a genuine multi-process race (`test/distributed-lock.test.ts`'s
last test spawns 6 independent OS processes — via `node:child_process.fork`,
mirroring `escrow-server/test/concurrent-confirm-release-child.ts`'s exact
pattern — that really race the same lock key through real file I/O, not
`Promise.all` timing luck on one process). That test runs against
`LocalFileConditionalStore`, a test-only backend built purely to get real
OS-level atomicity without needing R2 credentials — production uses
`R2ConditionalStore` instead (`src/r2-conditional-store.ts`), which talks
to the real R2 API via `@aws-sdk/client-s3`. Both implement the identical
`ConditionalStore` interface that `distributed-lock.ts`'s actual algorithm
is written against, so what the tests prove about the algorithm transfers
directly — but, same honesty boundary as the Litestream section above:
**`R2ConditionalStore` has never been run against a real R2 bucket** (no
Cloudflare credentials in this environment). Before trusting it in
production, run it through the same scenarios
`test/distributed-lock.test.ts` proves against `LocalFileConditionalStore` —
concurrent acquire, TTL-expiry reclaim, crash-then-reclaim — pointed at a
real bucket instead.

Not built yet: nothing actually calls `acquireLock`/`releaseLock` as part
of a real request lifecycle — that wiring is issue #10's scale-to-zero
compute wrapper, which is the first place this lock has a caller.

## Why WAL mode matters here

Litestream replicates by streaming the SQLite WAL file — a database in the
default rollback-journal mode gives it nothing to follow. `registry-server/src/db.ts`'s
`openDatabase` now sets `PRAGMA journal_mode = WAL;` unconditionally (safe
no-op for `:memory:` connections, which SQLite doesn't support WAL for at
all) specifically so this works. This also happens to be SQLite's own
recommended mode for this project's actual access pattern — two processes
sharing one file — and measurably reduced lock contention in
`escrow-server`'s genuine-concurrency tests once enabled.
