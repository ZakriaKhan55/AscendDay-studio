/**
 * What a missed library habit, a slip or an unlogged bad-habit day costs. Mirrors the SQL in
 * supabase/migrations/20261124120000_rank_penalties.sql; change both sides together.
 * On its own (no imports) so the public feature pages can show the same numbers
 * (src/marketing); habitPenalties.ts re-exports it for the app. The rank lines below are the
 * Starter, Achiever and Performer minimums in lib/leagues/tiers.ts (a test keeps them equal).
 */

/** Season points where each penalty band starts (tiers.ts Starter, Achiever, Performer). */
export const MISS_PENALTY_RANKS = {
  /** Below this (Beginner) a miss costs nothing. */
  freeBelow: 200,
  /** From freeBelow up to this (Starter, Learner, Trainer) a miss costs half, rounded up. */
  fullFrom: 1400,
  /** From here (Performer and up) misses in a row grow faster. */
  escalateFrom: 2000,
} as const;

/** Share of the full penalty in the half band (Starter to Trainer). */
export const HALF_PENALTY_SHARE = 0.5;

/**
 * Mirror of ascend_miss_multiplier: the multiplier by how many bad periods in a row end with this
 * one (this one included) and the season points, before the rank band (see getMissPenalty).
 */
export function getMissPenaltyMultiplier(consecutiveMisses: number, seasonPoints: number = 0): number {
  const isPerformerOrAbove = seasonPoints >= MISS_PENALTY_RANKS.escalateFrom;

  if (!isPerformerOrAbove) {
    if (consecutiveMisses <= 1) return 1.0;
    return 1.5;
  } else {
    if (consecutiveMisses <= 1) return 1.0;
    if (consecutiveMisses === 2) return 2.0;
    return 2.5;
  }
}

/** Mirror of ascend_miss_rank_share: 0 at Beginner, HALF_PENALTY_SHARE to Trainer, 1 from Achiever. */
export function getMissPenaltyRankShare(seasonPoints: number = 0): number {
  if (seasonPoints < MISS_PENALTY_RANKS.freeBelow) return 0;
  if (seasonPoints < MISS_PENALTY_RANKS.fullFrom) return HALF_PENALTY_SHARE;
  return 1;
}

/**
 * Mirror of ascend_miss_effective_multiplier: the multiplier a penalty row stores (metadata and
 * reason), the rank share x getMissPenaltyMultiplier, e.g. 0, 0.5, 0.75, 1, 1.5, 2, 2.5.
 */
export function getEffectiveMissMultiplier(consecutiveMisses: number, seasonPoints: number = 0): number {
  return getMissPenaltyRankShare(seasonPoints) * getMissPenaltyMultiplier(consecutiveMisses, seasonPoints);
}

/**
 * Mirror of ascend_miss_penalty: the points one miss costs (a positive number; the caller negates
 * it). Beginner 0; Starter to Trainer half of the full penalty, rounded up, so never 0 there and
 * never more than the full one; Achiever and up base x multiplier, rounded half up (as before).
 */
export function getMissPenalty(basePoints: number, consecutiveMisses: number, seasonPoints: number = 0): number {
  const full = basePoints * getMissPenaltyMultiplier(consecutiveMisses, seasonPoints);
  if (seasonPoints < MISS_PENALTY_RANKS.freeBelow) return 0;
  if (seasonPoints < MISS_PENALTY_RANKS.fullFrom) return Math.ceil(full * HALF_PENALTY_SHARE);
  return Math.round(full);
}
