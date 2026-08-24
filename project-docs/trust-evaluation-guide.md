# Trust Evaluation Guide

The [reputation registry spec](agent-trust-layer-spec.md) defines what data
exists (`reputation_score`, `stake_amount`, `dispute_count`, ...) and the
[identity spec](identity-and-onboarding-spec.md) defines how an `agent_id`
earned the right to appear in it. Neither says how a *calling* agent should
actually decide "will I do business with this specific agent, for this
specific amount, right now." This doc is that decision procedure.

This is the part every agent (or the human/policy behind it) needs before
it ever calls `query_by_capability` in anger.

---

## 1. The question is never "is this agent trustworthy"

It's always: **"is this agent trustworthy enough for a transaction of this
size, given how much I can afford to lose if I'm wrong."**

A reputation score of `0.95` means something different for a $0.01 call
than a $500 one. Treat trust as a function of transaction value, not a
fixed pass/fail gate.

## 2. Pre-transaction checklist

Before calling a candidate agent's endpoint, a buyer should have already
pulled and evaluated:

```
1. query_reputation(agent_id)
     -> reputation_score, tx_count, dispute_count, stake_amount,
        recent_reviews, capability_tags

2. Does capability_tags actually contain what I need?
     Mismatch (or over-broad tags covering everything) is itself a
     red flag — see §4.

3. Is stake_amount >= K × my transaction amount?
     (K = 50 per the identity spec's minimum; demand higher K for
     unusually large one-off transactions, since the protocol minimum
     is a floor, not a recommendation for your specific risk tolerance.)

4. Is tx_count large enough that reputation_score means anything?
     A 5/5 score on 2 transactions is not the same claim as 5/5 on 200.
     Treat low-tx_count agents as unscored, not as trustworthy, even if
     the average is perfect.

5. Is dispute_count/tx_count within tolerance for the transaction's
   subjectivity? Mechanical tasks (schema validation) should have
   near-zero disputes. Subjective tasks (open-ended writing) will
   naturally run higher — don't apply one dispute threshold to both.

6. Is the agent pseudonymous or principal-linked (per identity spec §2
   Layer 3)? Pseudonymous agents get a lower per-transaction ceiling
   regardless of score, because there's no accountable party if
   arbitration itself fails or the agent disappears mid-dispute.

7. Is last_active recent relative to the claimed SLA? A stale agent
   with a great historical score may not actually respond.
```

None of this requires trusting the *counterparty* — it only requires
trusting the Registry's data, which is itself protected by the
"reviews only attach to a real settled transaction" rule in the parent
spec. That's the actual root of trust in this system: not the agent, not
the registry operator, but the fact that reviews cost real settled money
to produce.

## 3. Tiered policy by transaction value

Don't run the same policy at every price point — the cost of the checks
themselves has to stay proportional to what's at stake.

| Tier | Range | Escrow | Min tx_count | Min stake ratio (K) | Arbiter pre-selected |
|---|---|---|---|---|---|
| Micro | < $0.05 | Optional | 0 | 10 | No |
| Standard | $0.05 – $10 | Required | 5 | 50 | No |
| High-value | > $10 | Required | 25 | 100 | Yes, quorum of 3 |

These are starting defaults, not protocol-enforced constants — a given
buyer agent (or the human operating it) should be able to tighten them.
The Registry and Escrow Layer should expose the raw fields; policy
thresholds belong to the caller, not the infrastructure, because risk
tolerance is a buyer-side decision, not a global one.

`K` here is the ratio the *buyer* requires, separate from the identity
spec's protocol-minimum `K=50` at registration. A buyer transacting above
the registration tier's own price ceiling should require a higher ratio
than the floor the seller was allowed to register at.

## 4. Red flags that override a good score

A high `reputation_score` does not override any of these:

- **Manifest/DID mismatch** — `manifest_url` content's signature doesn't
  verify against the `agent_id`'s DID document. Stop; this isn't a trust
  judgment call, it's a broken identity proof (see identity spec §2).
- **Capability tag sprawl** — an agent claiming ten unrelated
  capability_tags at suspiciously uniform high scores across all of them.
  Real specialization tends to show uneven scores/volume across tags.
- **Thin history, thick score** — see §2.4. Perfect score, near-zero
  volume.
- **Refusal to use escrow above the Micro tier** — an agent that only
  wants direct payment for a Standard/High-value transaction is asking
  you to skip the one mechanism that makes payment-before-verification
  safe. Decline regardless of score.
- **Fresh wallet_address** — no on-chain history behind the wallet the
  stake is bonded from. Stake amount alone doesn't establish it's been
  held long enough to be costly to abandon. (Wallet-age heuristics are
  intentionally left to the calling agent/policy layer, not the Registry
  — see identity spec §5.)
- **Score cliff in recent_reviews** — last few reviews trending down
  sharply even if the aggregate `reputation_score` (decayed/weighted per
  the parent spec's formula) hasn't caught up yet. The aggregate lags;
  the recent window doesn't.
- **Concentrated counterparty history** — `query_reputation`'s
  `counterparty_concentration` shows what share of an agent's settled
  transactions (by count, and by value) is with its single most frequent
  counterparty. A `share_by_count` near 1.0 on a multi-transaction history
  is the reciprocal-inflation shape: two colluding agents trading fake
  settled transactions back and forth to inflate each other's score costs
  only stake round-trips at trivial claimed prices. This does NOT prove
  collusion — a specialist with one dominant client looks identical — so
  treat it as a reason to inspect (`recent_reviews`, transaction values,
  task hashes) before trusting an otherwise-good score, not as automatic
  disqualification.

## 5. What arbitration means for pre-transaction trust

Choosing the arbiter *before* the transaction (parent spec §4) is itself
a trust input, not just a dispute-time detail. Before committing to a
High-value transaction, evaluate the pre-selected arbiter's own
`query_reputation` the same way you'd evaluate the counterparty — an
arbiter pool member with `capability_tag: arbitration` and a thin or
disputed record is a reason to require a different quorum, not a reason
to skip the check because "arbitration is a fallback I probably won't
need."

## 6. Summary

Trust in this system is never "I believe this agent." It's:

```
verified identity (control proof)
+ stake proportional to what I'm risking
+ enough real, escrow-settled transaction volume to make the score meaningful
+ escrow + pre-selected arbitration for anything above trivial value
= a transaction I can enter without having to trust the counterparty at all
```

If any one of those is missing, the correct response is to lower the
transaction tier you're willing to extend — not to skip the check because
the other signals look good.
