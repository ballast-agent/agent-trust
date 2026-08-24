// Value-weighted, time-decayed reputation score from
// project-docs/agent-trust-layer-spec.md §2:
//
//   score = Σ(outcome_weight_i × tx_value_i × decay(now - tx_time_i))
//         / Σ(tx_value_i × decay(now - tx_time_i))
//
// Computed on read rather than stored on the agent row — per
// DATA_AND_STATE.md's derived-state rule, this is cheap enough to recompute
// at prototype scale and avoids a second source of truth that could drift
// from the underlying reviews.

export type ReviewOutcome = "satisfied" | "partial" | "failed";

export interface ScoringInput {
  outcome: ReviewOutcome;
  amount: number;
  resolvedAtMs: number;
}

const OUTCOME_WEIGHT: Record<ReviewOutcome, number> = {
  satisfied: 1.0,
  partial: 0.5,
  failed: 0.0,
};

const HALF_LIFE_MS = 90 * 24 * 60 * 60 * 1000;
const DECAY_LAMBDA = Math.log(2) / HALF_LIFE_MS;

function decay(ageMs: number): number {
  return Math.exp(-DECAY_LAMBDA * Math.max(0, ageMs));
}

export function computeReputationScore(reviews: ScoringInput[], now: number = Date.now()): number {
  if (reviews.length === 0) return 0;
  let numerator = 0;
  let denominator = 0;
  for (const review of reviews) {
    const weight = OUTCOME_WEIGHT[review.outcome];
    const weightedDecay = decay(now - review.resolvedAtMs) * review.amount;
    numerator += weight * weightedDecay;
    denominator += weightedDecay;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Protocol-level stake requirement from identity-and-onboarding-spec.md §3. */
export const STAKE_RATIO_K = 50;

export function requiredStake(priceSchedule: Record<string, string>): number {
  const prices = Object.values(priceSchedule).map(parsePriceAmount);
  if (prices.length === 0) return 0;
  return STAKE_RATIO_K * Math.max(...prices);
}

/** Parses "0.004 USDC" style price strings into a numeric amount. */
export function parsePriceAmount(price: string): number {
  const match = price.trim().match(/^([\d.]+)/);
  if (!match) throw new Error(`unparseable price: ${price}`);
  return Number.parseFloat(match[1]);
}

// --- dyad concentration -----------------------------------------------------
//
// A purely derived collusion *signal* (issue #20), not a judgment: two
// colluding agents can trade fake settled transactions back and forth to
// inflate each other's reputation_score — submit_review only requires a real
// settled transaction, not an economically meaningful one. A genuine market
// participant tends to spread settled volume across counterparties; a
// reciprocal-inflation ring concentrates it in one. This converts "trust the
// aggregate score" into "inspect this suspicious shape" (trust-evaluation-
// guide.md §4). Concentration does not prove collusion — a niche specialist
// can legitimately serve one dominant client.

export interface CounterpartyTx {
  counterparty_id: string;
  amount: number;
}

export interface DyadConcentration {
  /** The single most frequent settled-transaction counterparty, or null when
   * the agent has no settled transactions. */
  top_counterparty_id: string | null;
  /** Settled transactions with that counterparty. */
  top_counterparty_tx_count: number;
  /** Share of the agent's settled transaction COUNT with that counterparty:
   * 1.0 = every settled tx is with them, 0 = no settled history. */
  share_by_count: number;
  /** Same ratio weighted by transaction amount ("volume"). Reported alongside
   * share_by_count because they fail differently: a ring trading many trivial
   * txs dilutes value-share by mixing in one real large job; count-share
   * still catches it, and vice versa. */
  share_by_value: number;
}

export function computeDyadConcentration(txs: CounterpartyTx[]): DyadConcentration {
  if (txs.length === 0) {
    return { top_counterparty_id: null, top_counterparty_tx_count: 0, share_by_count: 0, share_by_value: 0 };
  }
  const byCounterparty = new Map<string, { count: number; amount: number }>();
  for (const tx of txs) {
    const entry = byCounterparty.get(tx.counterparty_id) ?? { count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += tx.amount;
    byCounterparty.set(tx.counterparty_id, entry);
  }
  let totalAmount = 0;
  for (const entry of byCounterparty.values()) totalAmount += entry.amount;
  // Most settled txs wins; ties break by larger amount, then by id, so the
  // reported counterparty never depends on row ordering.
  const [top, topEntry] = [...byCounterparty.entries()].sort(
    (a, b) => b[1].count - a[1].count || b[1].amount - a[1].amount || (a[0] < b[0] ? -1 : 1)
  )[0];
  return {
    top_counterparty_id: top,
    top_counterparty_tx_count: topEntry.count,
    share_by_count: topEntry.count / txs.length,
    share_by_value: totalAmount === 0 ? 0 : topEntry.amount / totalAmount,
  };
}
