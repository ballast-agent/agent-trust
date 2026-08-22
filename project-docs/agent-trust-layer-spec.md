# Agent Trust Layer: Reputation Registry + Escrow Protocol Spec

A minimal, prototypeable slice of "agent web" infrastructure: an MCP server that
lets agents (a) look up who they can trust before paying them, and (b) route
payment through escrow so a bad actor can't just take the money and vanish.

See also:
- [identity-and-onboarding-spec.md](identity-and-onboarding-spec.md) — how an
  `agent_id` earns the right to appear in the registry at all.
- [trust-evaluation-guide.md](trust-evaluation-guide.md) — the decision
  procedure a calling agent runs against this registry's data before
  transacting, tiered by transaction value.

Two services, one shared data model:

1. **Reputation Registry** — read/write ledger of agent identities, capability
   claims, and verified transaction history.
2. **Escrow Layer** — holds x402 stablecoin payment in a locked state until a
   deliverable is confirmed, then releases funds and writes the outcome back
   to the Registry.

---

## 1. Core data model

```
Agent {
  agent_id: string            # DID or wallet address, canonical identity
  manifest_url: string        # points to capability manifest (MCP tool list + pricing)
  wallet_address: string      # where payments settle
  stake_amount: decimal       # bonded collateral, slashable on confirmed fraud
  reputation_score: float     # 0.0–1.0, decays over time, weighted by tx value
  tx_count: int
  dispute_count: int
  created_at: timestamp
  last_active: timestamp
}

Transaction {
  tx_id: string
  payer_id: string
  payee_id: string
  amount: decimal
  currency: string             # e.g. USDC
  task_hash: string            # hash of the task spec, for dispute reference
  deliverable_hash: string     # hash of what was actually delivered
  status: enum[pending, escrowed, verified, released, disputed, refunded, slashed]
  escrow_deadline: timestamp   # auto-refund payer if payee doesn't deliver in time
  created_at: timestamp
  resolved_at: timestamp
}

Review {
  tx_id: string                # foreign key — reviews only attach to real settled tx
  reviewer_id: string
  outcome: enum[satisfied, partial, failed]
  notes: string                # optional, free text
  signed_at: timestamp
  signature: string             # reviewer signs their own review, non-repudiable
}
```

Key design choice: **reviews are only writable against a real, settled
`Transaction`.** No transaction, no review. This is the single biggest
defense against reputation-gaming — you can't buy five-star ratings without
actually moving money through escrow each time, and the stake requirement
makes farming fake reviews expensive.

---

## 2. Reputation Registry — MCP tool surface

```
register_agent(manifest_url, wallet_address, stake_amount) -> agent_id
  # Bonds stake, verifies manifest is well-formed, issues agent_id (DID-based)

query_reputation(agent_id) -> {
  reputation_score, tx_count, dispute_count, stake_amount,
  recent_reviews: Review[10], capability_tags: string[]
}
  # This is the call every agent makes BEFORE paying anyone.
  # No auth required — reputation is meant to be publicly queryable.

query_by_capability(capability_tag, min_reputation, max_price) -> Agent[]
  # "find me a summarization agent with rep > 0.9 under $0.01/call"
  # This is the discovery/search primitive.

submit_review(tx_id, outcome, notes, signature) -> ack
  # Only callable by payer or payee of a *settled* transaction.
  # Called automatically by the Escrow Layer on release/refund/slash —
  # agents don't have to remember to review, the escrow flow does it for them.

slash_stake(agent_id, tx_id, reason) -> ack
  # Only callable by the Escrow Layer or an authorized Arbitration Agent
  # on a confirmed dispute finding. Burns or redistributes stake.

get_manifest(agent_id) -> manifest_json
  # Proxies/caches the agent's own published capability manifest.
```

Reputation score isn't a simple average — it should be value-weighted and
time-decayed so a $10k flawless track record can't be erased by one bad $0.01
call, and stale agents don't coast forever on old wins:

```
score = Σ(outcome_weight_i × tx_value_i × decay(now - tx_time_i)) / Σ(tx_value_i × decay(...))
```

---

## 3. Escrow flow (this is the part that actually needs x402)

The sequence for a single paid task between Agent A (buyer) and Agent B (seller):

```
1. A queries Registry: query_by_capability("csv-parsing", min_rep=0.85)
   -> gets back B, with price and reputation attached

2. A calls B's endpoint directly (MCP tool call).
   B responds: HTTP 402 Payment Required
     { amount: 0.004 USDC, escrow_contract: 0xabc..., task_hash: "sha256:..." }

3. A signs and submits payment to the ESCROW CONTRACT, not directly to B.
     - Funds lock under tx_id, deadline = now + B's stated SLA
     - Escrow Layer calls Registry.query_reputation(B) as a sanity check
       before even accepting the escrow (skip escrow entirely and refuse
       the tx if B's rep is below A's configured floor)

4. B sees payment confirmed on-chain / via escrow webhook, executes the task,
   returns deliverable_hash + deliverable to A.

5. A verifies deliverable_hash matches what was promised (or runs a
   cheap automated check — schema validation, checksum, etc.)
     - Happy path: A calls escrow.confirm(tx_id) -> funds release to B
       -> Escrow Layer auto-calls submit_review(tx_id, satisfied)
     - No response from A within a grace window -> auto-release (prevents
       buyers from freeloading by just never confirming)

6. Unhappy path: A calls escrow.dispute(tx_id, reason)
     - Funds stay locked, routed to an Arbitration Agent (see §4)
     - Arbitration outcome writes back: release / refund / slash
```

The critical property: **B never has to trust A to pay after delivery, and A
never has to trust B to deliver after paying.** Escrow is the only thing that
makes payment-before-verification workable between two parties with zero
human oversight and no legal recourse.

---

## 4. Arbitration (the part everyone skips, and shouldn't)

Disputes need a resolver neither party controls. Minimal viable version:

- A pool of **Arbitration Agents**, themselves registered in the same
  Reputation Registry (recursion — they're just agents with a
  `capability_tag: "arbitration"`), each staked.
- Both A and B's original contract specifies an arbitration agent (or a
  randomly-selected quorum of 3) at time of escrow creation — not
  after-the-fact, so neither side can shop for a friendly arbiter.
- The arbiter's job is narrow and mechanical where possible: compare
  `deliverable_hash` against `task_hash`'s spec, check timestamps against
  the SLA, and rule. For genuinely subjective quality disputes, this is
  the hard unsolved part — probably starts as "arbiter re-runs a cheap
  LLM-as-judge pass against the original task spec" and gets more
  sophisticated over time.
- Losing party's stake takes the slash, not just their escrowed payment —
  this is what makes stake meaningful instead of decorative.

---

## 5. Minimal escrow contract sketch (pseudocode, chain-agnostic)

```solidity
struct Escrow {
    address payer;
    address payee;
    uint256 amount;
    bytes32 taskHash;
    bytes32 deliverableHash;
    uint256 deadline;
    address arbiter;
    Status status; // Pending, Delivered, Released, Disputed, Refunded
}

function createEscrow(payee, taskHash, deadline, arbiter) payable returns (txId)
function submitDeliverable(txId, deliverableHash)          // only payee
function confirmRelease(txId)                              // only payer, or auto after grace period
function raiseDispute(txId, reason)                         // only payer or payee
function resolveDispute(txId, outcome)                      // only designated arbiter
function reclaimExpired(txId)                                // payer, if payee never delivered by deadline
```

---

## 6. What to prototype first

Smallest end-to-end slice that proves the concept, roughly in order:

1. **Registry as a plain MCP server**, in-memory or SQLite backing store —
   `register_agent`, `query_reputation`, `submit_review`. No chain yet.
2. **Fake escrow** — a simple state machine (not on-chain) that mimics the
   lock/release/dispute flow using a testnet stablecoin, so you can validate
   the *protocol shape* before dealing with real contract security.
3. **Two toy agents** (buyer/seller scripts) that actually run the full loop:
   query registry → get quoted 402 → pay into escrow → deliver → confirm →
   review gets written automatically.
4. Only after that loop works end-to-end: swap the fake escrow for a real
   x402-compatible smart contract on a testnet, and get an external security
   review before anything touches real funds — escrow contracts are exactly
   the kind of thing that gets drained by a subtle reentrancy bug if rushed.

---

## Open questions worth deciding early

- **Identity**: resolved — DID-based, not registry-issued. Full rationale
  and the three-layer verification flow (key control, manifest control,
  optional principal link) are in
  [identity-and-onboarding-spec.md](identity-and-onboarding-spec.md).
- **Sybil resistance**: resolved at the registration level — stake must
  scale with claimed capability price tier (`required_stake >= K ×
  max_price`, protocol-level `K`, not agent-chosen). See identity spec §3.
  Callers may additionally require a higher ratio for their own risk
  tolerance at transaction time — see
  [trust-evaluation-guide.md](trust-evaluation-guide.md) §3.
- **Who pays gas/settlement fees on sub-cent transactions** — this is the
  actual reason x402 matters over a traditional chain; confirm which chain/L2
  you're targeting has fees low enough that a $0.0004 payment isn't 90% fees.
