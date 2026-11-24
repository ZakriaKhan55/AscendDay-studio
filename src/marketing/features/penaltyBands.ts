import { BEGINNER_MISS_PENALTY, getMissPenalty, MISS_PENALTY_RANKS } from '@/lib/points/missPenalty';
import { PENALTY_TIERS, TIERS } from '@/lib/leagues/tiers';
import { fmt } from './format';

/**
 * The miss penalty by rank for the public pages, straight from lib/points/missPenalty.ts (SQL
 * ascend_miss_penalty) and lib/leagues/tiers.ts: a flat 1 point at Beginner (never more in a row),
 * half (rounded up) from Starter to Trainer, the full amount from Achiever.
 */
const { flat, half, full, escalate } = PENALTY_TIERS;
/** "1 point". */
const flatPoints = `${BEGINNER_MISS_PENALTY} point${BEGINNER_MISS_PENALTY === 1 ? '' : 's'}`;
/** The last rank of the half band (Trainer). */
const lastHalf = TIERS[TIERS.indexOf(full) - 1] ?? half;

export const penaltyBand = {
  flat,
  half,
  lastHalf,
  full,
  escalate,
  /** A season-points value inside each band, for worked examples. */
  seasonIn: { flat: 0, half: MISS_PENALTY_RANKS.flatBelow, full: MISS_PENALTY_RANKS.fullFrom, escalate: MISS_PENALTY_RANKS.escalateFrom },
};

/** The cost of the 1st, 2nd and 3rd miss in a row of a `base`-point habit at `season` points. */
export const missRun = (base: number, season: number): number[] => [1, 2, 3].map((n) => getMissPenalty(base, n, season));

/** "−1, −2, −2". */
export const negList = (list: number[]) => list.map((n) => `−${n}`).join(', ');

/** One plain sentence: "1 point at Beginner (never more in a row), half (rounded up) from Starter to Trainer, the full amount from Achiever." */
export const bandSentence = `${flatPoints} at ${flat.name} (never more in a row), half (rounded up) from ${half.name} to ${lastHalf.name}, the full amount from ${full.name}`;

/** "By rank: 1 point at Beginner (never more in a row), half (rounded up) from Starter to Trainer, the full amount from Achiever." */
export const byRankSentence = `By rank: ${bandSentence.charAt(0).toLowerCase()}${bandSentence.slice(1)}.`;

/** Rules rows for a "By rank" table; `what` names the thing that is missed ("a miss", "a slip or a day not logged"). */
export function penaltyBandRows(what: string) {
  return [
    {
      what: `${flat.name} (under ${fmt(half.minPoints)} season points)`,
      amount: `−${BEGINNER_MISS_PENALTY}`,
      tone: 'loss' as const,
      note: `${what[0].toUpperCase()}${what.slice(1)} costs ${flatPoints}, whatever the habit’s points, and never more in a row.`,
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
