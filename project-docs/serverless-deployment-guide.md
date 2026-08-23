# Serverless Deployment: Litestream + Scale-to-Zero Compute

**Status:** parts 1–2/4 (Litestream replication, the distributed lock) are
built — see [`deploy/`](../deploy). Parts 3–4 (the scale-to-zero compute
wrapper, and the HTTP/SSE MCP transport) are still design only, and are
also what's needed before the lock actually has a caller. See the
tracking issues linked at the bottom.

## The problem this solves

`registry-server` and `escrow-server` are two Node processes sharing one
SQLite file (`REGISTRY_DB_PATH`). That's fine for a demo run by one
operator on one machine, but it doesn't answer the actual "agent web"
question: how do independent parties (a buyer agent, a seller agent, an
arbiter agent, none of whom trust each other or share a machine) read and
write the *same* registry/escrow state without one of them volunteering to
run — and pay for — an always-on server the others depend on?

The goal here specifically is **zero idle cost**: nobody pays for compute
sitting around waiting for the next transaction. You only pay (in the
literal sense, or in free-tier request budget) for the moments a
transaction is actually happening.

## Why Litestream, and what it actually gives you

[Litestream](https://litestream.io) continuously streams a SQLite file's
WAL to an object store (S3-compatible — Cloudflare R2, in this design,
for its free egress and generous free tier) and can restore a file from
that replica on demand. It solves **durability without a database
server**: the canonical state lives in R2, not on whatever machine
happened to run the process last.

**What it does not give you for free: multiple simultaneous writers.**
Litestream replicates *one* process's WAL stream. It has no concept of two
independent processes writing to their own local copies of the file at the
same time and reconciling the result — that's a distributed-systems
problem Litestream deliberately doesn't solve. Any design that skips this
and just has "whichever agent wants to transact" independently restore,
write, and replicate will silently produce two diverging SQLite files the
moment two transactions overlap. This is the part of the design most
likely to be underestimated, so it gets its own section below.

## Architecture

```text
                    ┌─────────────────────────┐
                    │   Cloudflare R2 bucket   │   ← durable state lives here,
                    │  (Litestream replica +   │     not on any one machine
                    │   a tiny lock object)    │
                    └───────────┬─────────────┘
                                │ restore / replicate
                                ▼
                    ┌─────────────────────────┐
                    │  scale-to-zero compute   │   ← boots on request,
                    │  (Fly Machines, auto     │     shuts down after,
                    │  stop/start)             │     $0 while idle
                    │                          │
                    │  1. acquire write lock   │
                    │  2. litestream restore   │
                    │  3. run registry-server  │
                    │     + escrow-server,     │
                    │     serve the MCP call   │
                    │  4. litestream replicate │
                    │  5. release lock, exit   │
                    └───────────┬─────────────┘
                                │ MCP over HTTP/SSE
                                ▼
                    buyer agent / seller agent / arbiter agent
                    (each running wherever they run — no shared machine)
```

## The parts that need to exist (none of them do yet)

### 1. Litestream replication of the shared DB to R2 — ✅ built

[`deploy/litestream/litestream.yml`](../deploy/litestream/litestream.yml)
points at the SQLite file used by `registry-server`/`escrow-server`,
replicating continuously to an R2 bucket (R2 specifically, not raw S3, for
its free egress — every restore pulls the whole state back down, and that
should never cost anything at prototype scale). See
[`deploy/README.md`](../deploy/README.md) for bucket setup.

A genuine prerequisite this surfaced: Litestream replicates by streaming
the SQLite WAL file, which requires the database to actually be in WAL
mode — `registry-server/src/db.ts`'s `openDatabase` didn't set this before
(default rollback-journal mode gives Litestream nothing to follow). Fixed
by adding `PRAGMA journal_mode = WAL;` unconditionally (safe no-op for
`:memory:` tests) — which also happens to be SQLite's own recommended mode
for this project's actual access pattern, and measurably reduced lock
contention in `escrow-server`'s genuine-concurrency tests once enabled.

The replication *mechanism* is proven end to end by
[`deploy/src/litestream-smoke-test.ts`](../deploy/src/litestream-smoke-test.ts)
(`npm run smoke-test:litestream` in `deploy/`) using Litestream's local
`file` replica type — no R2/Cloudflare credentials needed, since Litestream's
replica backends are interchangeable by design. What's **not** verified is
the actual R2 config against a real bucket, since this environment has no
Cloudflare credentials — that still needs a real run before calling this
production-ready. `deploy/README.md` documents this distinction precisely,
plus a real Windows-only quirk found while building this (a non-fatal
directory-fsync error on `litestream restore`).

### 2. A single-writer lock — the part that actually matters — ✅ built

[`deploy/src/distributed-lock.ts`](../deploy/src/distributed-lock.ts) — a
mutex over R2's conditional-write support, exactly as originally sketched
here, with one correction: **release is a conditional `PutObject`
(overwrite with a `released` marker), not a delete** — confirmed against
[R2's actual API docs](https://developers.cloudflare.com/r2/api/s3/api/)
that `DeleteObject` supports no conditional headers at all, only
`PutObject` does. A crashed holder is recovered via TTL: any caller may
steal an expired-or-released lock through the same conditional-`PutObject`
path.

This was exactly as hard as flagged — the real design work was the
backend abstraction (`deploy/src/conditional-store.ts`'s `ConditionalStore`
interface) that lets the identical algorithm run against a production R2
backend (`R2ConditionalStore`, using `@aws-sdk/client-s3`) and a test-only
real-file backend (`LocalFileConditionalStore`, real OS-level atomicity via
exclusive file creation) without the algorithm itself knowing which one
it's talking to. All three tests this section originally called for exist
and pass, plus a fourth: two instances racing for the lock (proven twice —
once with many concurrent calls in one process, once with 6 genuinely
independent OS processes via `child_process.fork`, mirroring
`escrow-server`'s own proven concurrency-test pattern), a lock held past
its TTL being reclaimable, and a crash mid-transaction (holder never
releases) not wedging the system. See
[`deploy/README.md`](../deploy/README.md)'s "The distributed lock" section
for the honesty boundary: the algorithm and the conditional-store
abstraction are proven for real; `R2ConditionalStore` has never been run
against an actual R2 bucket, since this environment has no Cloudflare
credentials.

### 3. Scale-to-zero compute wrapper

The glue script that runs on the compute platform per invocation: acquire
lock → `litestream restore` → start the two MCP servers (or a lighter
in-process call into their `tools.ts` functions directly, skipping the MCP
transport overhead for this internal step) → serve the request →
`litestream replicate`/checkpoint → release lock → let the platform
suspend/stop the instance. Fly.io Machines (auto stop/start) is the
leading candidate compute target because it can run the existing Node
process essentially unmodified, unlike a rewrite onto Cloudflare Workers
(see below).

### 4. MCP transport: stdio doesn't fit this model

`registry-server`/`escrow-server` currently speak MCP over stdio, spawned
1:1 per client process — fine for a single local operator, not for
independent remote parties triggering on-demand compute. This needs an
HTTP/SSE MCP transport (which the MCP spec already supports) fronting the
scale-to-zero wrapper, so a remote agent's tool call is literally the HTTP
request that wakes the machine up.

## Why not Cloudflare Workers + D1 instead?

That combination (raised earlier in this project's history) is arguably a
cleaner serverless target long-term, but it requires a much bigger rewrite:
`node:sqlite`'s synchronous API would need to become D1's async binding
API throughout `db.ts`, and — more importantly — `identity.ts`'s
`httpGetPinned()` (added in PR #1 specifically to close a DNS-rebinding
gap by dialing a pre-resolved IP via raw `node:http`/`node:https` +
`dns.lookup`) has no equivalent on Workers, which expose no raw sockets or
`dns.lookup`. The Litestream + scale-to-zero approach keeps the existing
Node/`node:sqlite`/pinned-socket code intact and only changes *how it's
invoked and where its data lives* — a smaller, more reviewable change for
a project this security-sensitive.

## Known limitations of this whole approach, going in

- **Cold-start latency per transaction.** Every transaction pays a
  restore-then-serve-then-replicate round trip. Fine for a trust-layer
  prototype; not a design for high-frequency trading.
- **Single-writer throughput ceiling.** By construction, only one
  transaction is ever in flight system-wide at a time. Acceptable at
  prototype scale; a real bottleneck if this ever needs concurrent
  throughput, at which point this design should be revisited rather than
  patched further.
- **This is a cost-shape change, not a security or correctness change.**
  Everything in `coding-docs/SECURITY_GUARDRAILS.md` and
  `DATA_AND_STATE.md`'s invariants still has to hold under this model —
  if anything, the lock-timeout/crash-recovery edge cases below need
  *more* scrutiny than the current single-process model, not less.

## Tracking issues

- [#8 — Litestream + R2 replication setup](https://github.com/loomweaver-agent/agent-trust/issues/8)
- [#9 — the single-writer distributed lock](https://github.com/loomweaver-agent/agent-trust/issues/9)
- [#10 — scale-to-zero compute wrapper (Fly Machines)](https://github.com/loomweaver-agent/agent-trust/issues/10)
- [#11 — MCP HTTP/SSE transport for both servers](https://github.com/loomweaver-agent/agent-trust/issues/11)

Do these roughly in order — 3/4 (the compute wrapper) depends on 1/4 and
2/4 existing, and needs 4/4 (HTTP transport) to actually be reachable by a
remote party rather than just runnable locally.
