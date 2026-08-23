# AgentTrust Escrow Server

The Escrow Layer from
[project-docs/agent-trust-layer-spec.md](../project-docs/agent-trust-layer-spec.md)
§3 and §5 — step 2 of that spec's prototyping order. A plain, non-chain
state machine (per §6: "no real payment rail yet"), implemented as an MCP
server.

## It shares registry-server's database — this is not optional

The spec frames this as "two services, one shared data model." The
`transactions` table already lives in
[`registry-server/src/db.ts`](../registry-server/src/db.ts) (used by
`submit_review`/`slash_stake`). This service does **not** define its own
copy — it imports `registry-server`'s `db.ts`/`identity.ts`/`tools.ts`
directly (relative imports across the two sibling packages) and must be
pointed at the exact same SQLite file via `REGISTRY_DB_PATH` in both
processes. Two separate databases would mean two independently-drifting
copies of transaction state — exactly what
[DATA_AND_STATE.md](../coding-docs/DATA_AND_STATE.md)'s "one source of
truth" rule exists to prevent.

Because of this, escrow-server runs via `tsx` directly against source
rather than a separately-compiled `dist/` — a `tsc`-compiled sibling
package would need its own matching `dist/` layout for the cross-package
relative imports to resolve at runtime, which `registry-server` doesn't
provide (no `.d.ts` output, no path mapping). `tsx` sidesteps this by
resolving both packages' `.ts` sources directly, which is also simpler for
a two-service prototype than introducing npm workspaces this early.

## Tools

| Tool | Spec reference |
|---|---|
| `create_escrow` | §3 step 3 — locks funds, pre-selects an arbiter (§4), optional reputation floor |
| `submit_deliverable` | §3 step 4 — payee submits `deliverable_hash` |
| `confirm_release` | §3 step 5 — payer confirms, funds release, review auto-recorded |
| `raise_dispute` | §3 step 6 — either party freezes the transaction |
| `resolve_dispute` | §4 — pre-selected arbiter releases/refunds/slashes (slash delegates to Registry's `slash_stake`) |
| `reclaim_expired` | §5 `reclaimExpired` — payer reclaims after SLA deadline with no delivery |
| `sweep_auto_release` | §3 step 5 — auto-release past the grace window (see limitation below) |

## Setup

```bash
npm install
npm test          # 8 tests, in-memory shared db
npm run typecheck
```

## Running

Both processes must share one SQLite file:

```bash
# terminal 1
cd registry-server && REGISTRY_DB_PATH=../shared.db npm run build && node dist/src/server.js

# terminal 2
cd escrow-server && REGISTRY_DB_PATH=../shared.db npm start
```

## Why signatures are required on almost everything

Every state-changing tool here takes a `signature` (or `authorization`)
proving the actual party authorized the action — there is no session/auth
layer beyond that, matching registry-server's design. This matters most for
`confirm_release`: the spec describes the Escrow Layer as "auto-calling"
`submit_review` on release, but this server never holds any agent's private
key, so it cannot forge a review on the payer's behalf. Instead,
`confirm_release` requires the payer's signature over *both* the release
and the review in one call — "automatic" from the caller's point of view,
without weakening the review's authenticity guarantee from
[identity-and-onboarding-spec.md](../project-docs/identity-and-onboarding-spec.md).

## Known limitation

`sweep_auto_release` (the "no response within a grace window" path from
spec §3 step 5) has the opposite problem: it's genuinely automatic, so
there's no payer signature available at all, and the resulting release
does **not** get an automatic review — see the comment on
`sweepAutoRelease` in `src/tools.ts`. A future version could have the payer
pre-sign a conditional review at `create_escrow` time, redeemable only on
this path; not built here, ahead of real usage data on how often
auto-release actually triggers.

## What's still not here

The two toy buyer/seller agents (step 3) are now built — see
[`../demo/`](../demo), which drives this service end-to-end alongside
`registry-server`. Still missing per the parent spec's ordering (§6): the
real x402 smart contract swap-in (step 4) — this remains entirely
off-chain until then.
