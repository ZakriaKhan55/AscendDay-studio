import { getMissPenaltyMultiplier } from '@/lib/points/missPenalty';
import { PENALTY_TIERS } from '@/lib/leagues/tiers';

/**
 * Miss / slip rules for the guides (lib/points/missPenalty.ts = SQL ascend_miss_penalty): the rank
 * bands (nothing at Beginner, half rounded up from Starter, full from Achiever) and the multipliers
 * for misses in a row, with the rank where they grow.
 */
const escalate = PENALTY_TIERS.escalate;
export const missRule = {
  rank: escalate.name,
  /** Every further bad day in a row below that rank. */
  again: getMissPenaltyMultiplier(2, 0),
  /** From that rank: the 2nd bad day in a row, and the 3rd on. */
  second: getMissPenaltyMultiplier(2, escalate.minPoints),
  third: getMissPenaltyMultiplier(3, escalate.minPoints),
  /** No points lost below this rank's start (Beginner). */
  free: PENALTY_TIERS.free.name,
  /** From this rank a miss costs half its points (HALF_PENALTY_SHARE), rounded up. */
  half: PENALTY_TIERS.half.name,
  /** From this rank a miss costs its full points. */
  full: PENALTY_TIERS.full.name,
};
