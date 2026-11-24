import { MISS_PENALTY_RANKS } from '../points/missPenalty';

export interface Tier {
  name: string;
  minPoints: number;
  color: string;
  icon: string; // lucide icon name
  description: string;
}

export const TIERS: Tier[] = [
  {
    name: 'Beginner',
    minPoints: 0,
    color: '#94a3b8',
    icon: 'Compass',
    description: 'Where everyone starts each season. Each miss costs just 1 point.',
  },
  {
    name: 'Starter',
    minPoints: 200,
    color: '#38bdf8',
    icon: 'Rocket',
    description: 'You have made a start on your daily habits. Misses now cost half their points.',
  },
  {
    name: 'Learner',
    minPoints: 500,
    color: '#34d399',
    icon: 'BookOpen',
    description: 'Your daily routine is starting to stick. Misses still cost half their points.',
  },
  {
    name: 'Trainer',
    minPoints: 900,
    color: '#fb923c',
    icon: 'Dumbbell',
    description: 'You put in the work on most days. Misses still cost half their points.',
  },
  {
    name: 'Achiever',
    minPoints: 1400,
    color: '#a3e635',
    icon: 'Trophy',
    description: 'Your steady work is paying off. Misses cost their full points.',
  },
  {
    name: 'Performer',
    minPoints: 2000,
    color: '#a78bfa',
    icon: 'Swords',
    description: 'From this rank up, misses in a row cost more points.',
  },
  {
    name: 'Expert',
    minPoints: 2700,
    color: '#14b8a6',
    icon: 'Crosshair',
    description: 'You keep a strong pace through the season.',
  },
  {
    name: 'Leader',
    minPoints: 3500,
    color: '#ef4444',
    icon: 'Flag',
    description: 'You are close to the top of the ladder.',
  },
  {
    name: 'Master',
    minPoints: 5000,
    color: '#eab308',
    icon: 'Crown',
    description: 'The top rank of the season.',
  },
];

/** The rank that starts at a penalty band's line, by season points (missPenalty.ts). */
const tierStartingAt = (points: number): Tier => TIERS.find((t) => t.minPoints === points) ?? getCurrentTier(points);

/**
 * The ranks of the miss penalty bands (lib/points/missPenalty.ts MISS_PENALTY_RANKS, SQL
 * ascend_miss_penalty): below `half` (at `flat`, Beginner) a miss costs a flat 1 point, from `half`
 * half its points (rounded up), from `full` its full points, from `escalate` misses in a row grow faster.
 */
export const PENALTY_TIERS = {
  flat: TIERS[0],
  half: tierStartingAt(MISS_PENALTY_RANKS.flatBelow),
  full: tierStartingAt(MISS_PENALTY_RANKS.fullFrom),
  escalate: tierStartingAt(MISS_PENALTY_RANKS.escalateFrom),
};

export function getCurrentTier(totalPoints: number): Tier {
  let current = TIERS[0];
  for (const tier of TIERS) {
    if (totalPoints >= tier.minPoints) current = tier;
  }
  return current;
}

export function getNextTier(totalPoints: number): Tier | null {
  for (const tier of TIERS) {
    if (totalPoints < tier.minPoints) return tier;
  }
  return null;
}

export function getTierIndex(totalPoints: number): number {
  let idx = 0;
  for (let i = 0; i < TIERS.length; i++) {
    if (totalPoints >= TIERS[i].minPoints) idx = i;
  }
  return idx;
}

export function getProgressToNextTier(totalPoints: number): { current: number; needed: number; percent: number } {
  const current = getCurrentTier(totalPoints);
  const next = getNextTier(totalPoints);
  if (!next) return { current: totalPoints, needed: current.minPoints, percent: 100 };
  const range = next.minPoints - current.minPoints;
  const progress = totalPoints - current.minPoints;
  return { current: progress, needed: range, percent: Math.min(100, (progress / range) * 100) };
}
