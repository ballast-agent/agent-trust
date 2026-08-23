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
| `create_escrow` | §3 step 3 — locks funds, pre-selects a single arbiter (opt-in) or a verifiably-random registry quorum of 3 (§4), optional reputation floor, optional payer pre-signed satisfied review for the auto-release path |
| `submit_deliverable` | §3 step 4 — payee submits `deliverable_hash` |
| `confirm_release` | §3 step 5 — payer confirms, funds release, review auto-recorded |
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

## Arbitration: opt-in single arbiter, or a verifiably-random quorum of 3

`create_escrow` takes exactly one of `arbiter_id` (a single pre-selected
arbiter — an explicitly opt-in weaker mode that does NOT meet spec §4's
"no shopping" property, since the caller picked the arbiter themselves)
or `arbiter_selection: "registry_quorum"` (the spec-compliant mode).
Internally both are stored as the same `arbiter_ids` array on the
transaction — a single arbiter is just a quorum of 1 — so `resolve_dispute`
doesn't need two separate code paths.

With `registry_quorum`, escrow-server itself selects the 3 arbiters from
the Registry's registered arbitration-tagged agents, excluding both
transacting parties (spec §4: "a resolver neither party controls"). The
selection is deterministic given a seed over inputs neither party controls
alone — the server-generated `tx_id`, the server clock at creation, and
the registry-wide agent count:

```
seed = sha256("agenttrust/arbiter-quorum-v1|<tx_id>|<created_at>|<agent_count>")
```

The seed is stored on the transaction row (`arbiter_seed`) and the
selection (`selectArbiterQuorum` in `src/tools.ts`, a pure exported
function) recomputes it by repeatedly hashing the seed with a round
counter and indexing into the sorted eligible pool without replacement.
This is deliberately simple — hash-of-seed indexing, not a VRF. The
security story: the seed inputs are unknowable to the parties before
creation, stored afterward, and any participant can audit a past selection
by recomputing it against the pool; neither payer nor payee can steer it
toward a specific friendly arbiter without controlling the server clock,
the tx_id generation, or the registry-wide agent count. Creation fails
outright when fewer than 3 eligible third-party arbiters exist.

### The issue #2 hardening (both parties consent; pool has an economic floor)

[Issue #2](https://github.com/loomweaver-agent/agent-trust/issues/2)
escalated the original "no shopping" gap into a working attack: only the
payer signed `create_escrow`, so a buyer could name colluding sybil
arbiters and later force a refund/slash against a seller who never agreed
to any of them. Both halves of the fix are in place:

1. **Payee consent (required in both modes).** `create_escrow` takes a
   second required signature, `payee_signature`, over the *identical*
   payload as the payer's — including whichever arbiter mode was chosen.
   Neither party can impose arbiters (or a selection mode) the other never
   accepted, and consent over a different payload than the one being
   imposed fails verification.
2. **Sybil-resistant quorum pool.** Eligibility for `registry_quorum`
   selection requires `stake_amount >= ARBITER_MIN_STAKE` (exported from
   `src/tools.ts`, currently 1.0), not just the arbitration tag. Honest
   arbiters clear it naturally by claiming a *paid* arbitration tier — at
   the protocol's stake ratio K=50, pricing arbitration at 0.02 posts
   exactly 1.0 — while free ("0 USDC") sybils stake nothing and are
   excluded. Flooding a quorum now costs 3+ real stakes plus a distinct
   registered identity per attempt.

Remaining nuance: the single-`arbiter_id` path remains an explicitly
opt-in weaker mode (the parties still must BOTH sign for that specific
arbiter now, but they may choose any tagged agent regardless of stake),
and `ARBITER_MIN_STAKE` is a plain constant chosen ahead of real usage
data — revisit both once the protocol has live economics.

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

## Auto-release reviews: pre-signed conditional reviews

`sweep_auto_release` (the "no response within a grace window" path from
spec §3 step 5) has the opposite problem of `confirm_release`: it's
genuinely automatic, so there's no payer signature available at sweep
time, and the Escrow Layer never holds keys (so it cannot sign on the
payer's behalf). The fix: the payer MAY attach a `pre_signed_review` to
`create_escrow` — an advance Ed25519 signature over a satisfied review
(`{reviewer_id, outcome: "satisfied", notes, task_hash}`; `task_hash`
stands in for the not-yet-existing `tx_id`, binding the signature to
exactly this escrow so it can't be replayed onto another).

Redemption rules, enforced in `sweepAutoRelease` (`src/tools.ts`):

- Redeemed **only** if the transaction's actual final resolution is the
  auto-release path itself (the atomic verified → released CAS won by the
  sweep). A manual `confirm_release` uses its own fresh review signature;
  a dispute/refund resolution never redeems the pre-signature — an
  optimistic "satisfied" must not survive an arbitrated refund.
- An invalid or non-verifying stored signature degrades to the old
  no-review behavior rather than attaching anything mismatched. The
  signature is validated at *creation* time too, so a broken one fails
  the escrow creation outright instead of being quietly dropped weeks
  later by a sweep.
- Without a `pre_signed_review`, auto-release behaves exactly as before:
  payment settles, no review attaches.

Remaining nuance: refund/dispute resolutions still produce no review at
all — that's inherent (a pre-signed *satisfied* review is meaningless
there, and nobody signs "dissatisfied" in advance).

## What's still not here

The two toy buyer/seller agents (step 3) are now built — see
[`../demo/`](../demo), which drives this service end-to-end alongside
`registry-server`. Still missing per the parent spec's ordering (§6): the
real x402 smart contract swap-in (step 4) — this remains entirely
off-chain until then.
