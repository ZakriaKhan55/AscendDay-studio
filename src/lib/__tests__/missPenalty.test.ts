// The miss penalty by rank (lib/points/missPenalty.ts) against its SQL pair ascend_miss_penalty /
// ascend_miss_effective_multiplier (supabase/migrations/20261124120000_rank_penalties.sql): Beginner 0,
// Starter to Trainer half rounded up, Achiever and up unchanged. The expected values are the SQL's,
// checked in PGlite when the migration was written. Change both sides together.
import {
  getEffectiveMissMultiplier,
  getMissPenalty,
  getMissPenaltyMultiplier,
  getMissPenaltyRankShare,
  HALF_PENALTY_SHARE,
  MISS_PENALTY_RANKS,
} from '../points/missPenalty';
import { PENALTY_TIERS, TIERS } from '../leagues/tiers';
import { rankUpPenaltyNote } from '../leagues/rankCelebration';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

// 1. The band lines are the tiers' own minimums.
{
  const min = (name: string) => TIERS.find((t) => t.name === name)?.minPoints;
  assert(MISS_PENALTY_RANKS.freeBelow === min('Starter'), 'free below Starter');
  assert(MISS_PENALTY_RANKS.fullFrom === min('Achiever'), 'full from Achiever');
  assert(MISS_PENALTY_RANKS.escalateFrom === min('Performer'), 'escalates from Performer');
  assert(
    PENALTY_TIERS.free.name === 'Beginner' && PENALTY_TIERS.half.name === 'Starter' && PENALTY_TIERS.full.name === 'Achiever' && PENALTY_TIERS.escalate.name === 'Performer',
    'PENALTY_TIERS names'
  );
  // The copy says "half"; keep the share and the word together.
  assert(HALF_PENALTY_SHARE === 0.5, 'half is 0.5');
}

// 2. Rank share at the boundaries.
{
  const cases: [number, number][] = [[0, 0], [199, 0], [200, 0.5], [1399, 0.5], [1400, 1], [1999, 1], [2000, 1], [5000, 1]];
  for (const [season, share] of cases) assert(getMissPenaltyRankShare(season) === share, `share at ${season} = ${share}`);
}

// 3. getMissPenalty: [base, misses, season, penalty, effective multiplier] (same table as the PGlite run).
{
  const cases: [number, number, number, number, number][] = [
    // Beginner: nothing, whatever the base or the run.
    [1, 1, 0, 0, 0], [3, 3, 199, 0, 0], [2, 2, 100, 0, 0],
    // Starter to Trainer, first miss: half rounded up (1 -> 1, 2 -> 1, 3 -> 2).
    [1, 1, 200, 1, 0.5], [2, 1, 200, 1, 0.5], [3, 1, 200, 2, 0.5], [3, 1, 1399, 2, 0.5],
    // Repeat (x1.5 x0.5 = x0.75): 1 -> 1, 2 -> 2, 3 -> 3.
    [1, 2, 200, 1, 0.75], [2, 2, 500, 2, 0.75], [3, 2, 1399, 3, 0.75], [3, 5, 900, 3, 0.75],
    // Achiever: unchanged round(base x multiplier).
    [1, 1, 1400, 1, 1], [2, 2, 1400, 3, 1.5], [1, 2, 1400, 2, 1.5], [3, 2, 1999, 5, 1.5],
    // Performer and up: unchanged escalation.
    [3, 2, 2000, 6, 2], [3, 3, 2000, 8, 2.5], [1, 3, 2000, 3, 2.5], [2, 1, 5000, 2, 1],
  ];
  for (const [base, misses, season, penalty, effective] of cases) {
    assert(getMissPenalty(base, misses, season) === penalty, `penalty(${base}, ${misses}, ${season}) = ${penalty}, got ${getMissPenalty(base, misses, season)}`);
    assert(getEffectiveMissMultiplier(misses, season) === effective, `effective(${misses}, ${season}) = ${effective}`);
  }
}

// 4. Above Beginner never 0 and never more than the full (Achiever-style) penalty.
{
  for (const base of [1, 2, 3]) {
    for (const misses of [1, 2, 3, 4]) {
      for (const season of [200, 500, 900, 1399]) {
        const half = getMissPenalty(base, misses, season);
        const full = Math.round(base * getMissPenaltyMultiplier(misses, season));
        assert(half >= 1 && half <= full, `half band ${base}/${misses}/${season}: ${half} in 1..${full}`);
      }
    }
  }
}

// 5. Rank-up line: only when the climb leaves Beginner.
{
  const idx = (name: string) => TIERS.findIndex((t) => t.name === name);
  assert(rankUpPenaltyNote(idx('Beginner'), idx('Starter')) === 'Misses now cost points (half until Achiever).', 'Beginner -> Starter');
  assert(rankUpPenaltyNote(idx('Beginner'), idx('Trainer')) === 'Misses now cost points (half until Achiever).', 'Beginner -> Trainer (jump)');
  assert(rankUpPenaltyNote(idx('Beginner'), idx('Achiever')) === 'Misses now cost points.', 'Beginner -> Achiever (jump): full, no "half"');
  assert(rankUpPenaltyNote(idx('Starter'), idx('Learner')) === null, 'Starter -> Learner: no line');
  assert(rankUpPenaltyNote(idx('Trainer'), idx('Achiever')) === null, 'Trainer -> Achiever: no line');
  assert(rankUpPenaltyNote(-1, 99) === null, 'bad indexes: no line');
}

console.log('missPenalty: all passed');
