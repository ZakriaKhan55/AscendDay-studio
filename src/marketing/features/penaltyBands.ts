import { getMissPenalty, MISS_PENALTY_RANKS } from '@/lib/points/missPenalty';
import { PENALTY_TIERS, TIERS } from '@/lib/leagues/tiers';
import { fmt } from './format';

/**
 * The miss penalty by rank for the public pages, straight from lib/points/missPenalty.ts (SQL
 * ascend_miss_penalty) and lib/leagues/tiers.ts: nothing at Beginner, half (rounded up) from
 * Starter to Trainer, the full amount from Achiever.
 */
const { free, half, full, escalate } = PENALTY_TIERS;
/** The last rank of the half band (Trainer). */
const lastHalf = TIERS[TIERS.indexOf(full) - 1] ?? half;

export const penaltyBand = {
  free,
  half,
  lastHalf,
  full,
  escalate,
  /** A season-points value inside each band, for worked examples. */
  seasonIn: { free: 0, half: MISS_PENALTY_RANKS.freeBelow, full: MISS_PENALTY_RANKS.fullFrom, escalate: MISS_PENALTY_RANKS.escalateFrom },
};

/** The cost of the 1st, 2nd and 3rd miss in a row of a `base`-point habit at `season` points. */
export const missRun = (base: number, season: number): number[] => [1, 2, 3].map((n) => getMissPenalty(base, n, season));

/** "−1, −2, −2". */
export const negList = (list: number[]) => list.map((n) => `−${n}`).join(', ');

/** One plain sentence: "Nothing at Beginner, half (rounded up) from Starter to Trainer, the full amount from Achiever." */
export const bandSentence = `Nothing at ${free.name}, half (rounded up) from ${half.name} to ${lastHalf.name}, the full amount from ${full.name}`;

/** "By rank: nothing at Beginner, half (rounded up) from Starter to Trainer, the full amount from Achiever." */
export const byRankSentence = `By rank: ${bandSentence.charAt(0).toLowerCase()}${bandSentence.slice(1)}.`;

/** Rules rows for a "By rank" table; `what` names the thing that is missed ("a miss", "a slip or a day not logged"). */
export function penaltyBandRows(what: string) {
  return [
    {
      what: `${free.name} (under ${fmt(half.minPoints)} season points)`,
      amount: 'Nothing',
      tone: 'none' as const,
      note: `${what[0].toUpperCase()}${what.slice(1)} costs no points yet.`,
    },
    {
      what: `${half.name} to ${lastHalf.name} (${fmt(half.minPoints)}–${fmt(full.minPoints - 1)})`,
      amount: 'Half',
      tone: 'loss' as const,
      note: 'Half the full amount, rounded up, so never zero.',
    },
    {
      what: `${full.name} and up (${fmt(full.minPoints)}+)`,
      amount: 'Full',
      tone: 'loss' as const,
      note: 'The full amount.',
    },
  ];
}
