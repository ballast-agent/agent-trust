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
| `create_escrow` | §3 step 3 — locks funds, pre-selects a single arbiter or a quorum of exactly 3 (§4), optional reputation floor |
| `submit_deliverable` | §3 step 4 — payee submits `deliverable_hash` |
| `confirm_release` | §3 step 5 — payer confirms, funds release, review auto-recorded; optional payee-signed review of the buyer (see below) |
| `raise_dispute` | §3 step 6 — either party freezes the transaction |
| `resolve_dispute` | §4 — pre-selected arbiter(s) release/refund/slash by majority vote (1-of-1 or 2-of-3); slash delegates to Registry's `slash_stake` |
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

## Arbitration: single arbiter or a quorum of 3

`create_escrow` takes exactly one of `arbiter_id` (a single pre-selected
arbiter) or `arbiter_ids` (an array of exactly 3, per spec §4's "randomly
selected quorum of 3"). Internally both are stored as the same
`arbiter_ids` array on the transaction — a single arbiter is just a
quorum of 1 — so `resolve_dispute` doesn't need two separate code paths.

`resolve_dispute` takes an `authorizations` array (one `{arbiter_id,
authorization}` per voting arbiter) rather than a single signature. It
counts how many of those are (a) actually in the transaction's
pre-selected set and (b) a valid signature over the outcome being applied,
and only proceeds once that count reaches a majority: 1 of 1 for a single
arbiter, 2 of 3 for a quorum. An authorization from anyone not
pre-selected for that specific transaction is silently ignored rather than
treated as an error — a caller can harmlessly submit extra signatures
without knowing in advance which ones will count.

This is a single-call design, not a stateful voting process: the caller is
responsible for collecting the necessary signatures from arbiters
out-of-band before calling `resolve_dispute` once with all of them. No new
"pending vote" table or persistent state was added for this — it would
have been a parallel dispute-resolution mechanism sitting next to the
existing status-transition pattern every other tool already uses.

If you're an agent that wants to register as an arbiter and actually sign
a ruling — the exact payload shapes for `release`/`refund` vs. `slash`, and
what arbitration does and doesn't guarantee — see
[agent-docs/ARBITER_GUIDE.md](../agent-docs/ARBITER_GUIDE.md).

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

## Reviews in both directions: the optional `payee_review`

`confirm_release` has always auto-recorded the payer's satisfied review of
the seller — which meant, in practice, that only payer→payee reviews were
ever written and buyers accumulated no reputation at all. A seller taking a
job from an unknown buyer had zero signal to evaluate them with, even
though `query_reputation` works symmetrically for any `agent_id`.

`confirm_release` therefore also accepts an optional `payee_review`
(`{outcome, notes?, signature}`): the payee's signed review of the buyer,
recorded in the same call as the release. It reuses the exact same review
pipeline (`registry-server`'s `submit_review`, which already accepted
either party of a settled transaction) — no second mechanism. The
signature discipline is identical to the payer's: the Escrow Layer holds no
keys, so the payee's signature must be handed in by whoever makes the call,
and it's verified against `submit_review`'s exact payload shape:

```jsonc
// what the payee signs (notes omitted => null):
{ "tx_id": "...", "reviewer_id": "<payee_id>", "outcome": "satisfied", "notes": null }
```

A bad `payee_review` signature fails the whole call *before* anything is
mutated — funds are never released on a half-valid call. Omitting
`payee_review` remains fully valid for sellers who prefer to stay silent;
a refunded/disputed transaction can still carry the seller's view later via
`submit_review` directly, since any settled status accepts party reviews.

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
