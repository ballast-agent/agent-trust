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
