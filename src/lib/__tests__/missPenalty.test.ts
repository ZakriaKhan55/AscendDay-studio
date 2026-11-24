// The miss penalty by rank (lib/points/missPenalty.ts) against its SQL pair ascend_miss_penalty /
// ascend_miss_effective_multiplier (supabase/migrations/20261124120000_rank_penalties.sql): Beginner a
// flat 1 (v2), Starter to Trainer half rounded up, Achiever and up unchanged. The expected values are the SQL's,
// checked in PGlite when the migration was written. Change both sides together.
import {
  BEGINNER_MISS_PENALTY,
  getEffectiveMissMultiplier,
  getMissPenalty,
  getMissPenaltyMultiplier,
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
  assert(MISS_PENALTY_RANKS.flatBelow === min('Starter'), 'flat below Starter');
  assert(MISS_PENALTY_RANKS.fullFrom === min('Achiever'), 'full from Achiever');
  assert(MISS_PENALTY_RANKS.escalateFrom === min('Performer'), 'escalates from Performer');
  assert(
    PENALTY_TIERS.flat.name === 'Beginner' && PENALTY_TIERS.half.name === 'Starter' && PENALTY_TIERS.full.name === 'Achiever' && PENALTY_TIERS.escalate.name === 'Performer',
    'PENALTY_TIERS names'
  );
  // The copy says "half"; keep the share and the word together.
  assert(HALF_PENALTY_SHARE === 0.5, 'half is 0.5');
  // The copy says "1 point" at Beginner.
  assert(BEGINNER_MISS_PENALTY === 1, 'Beginner flat penalty is 1');
}

// 2. Beginner: a flat 1 for a 1, 2 or 3-point base, however many misses in a row; 199 vs 200.
{
  for (const base of [1, 2, 3]) {
    for (const misses of [1, 2, 3, 4, 10]) {
      for (const season of [0, 100, 199]) {
        assert(getMissPenalty(base, misses, season) === 1, `Beginner penalty(${base}, ${misses}, ${season}) = 1`);
        // The stored multiplier: the flat point as a share of the base, 2 decimals, never above 1 (no "x" label).
        const eff = getEffectiveMissMultiplier(base, misses, season);
        assert(eff === Math.round(100 / base) / 100 && eff <= 1, `Beginner effective(${base}, ${misses}, ${season}) = ${eff}`);
      }
    }
  }
  assert(getEffectiveMissMultiplier(3, 1, 0) === 0.33 && getEffectiveMissMultiplier(2, 1, 0) === 0.5 && getEffectiveMissMultiplier(1, 1, 0) === 1, 'Beginner 0.33 / 0.5 / 1');
  // A habit worth no points costs nothing at any rank.
  for (const season of [0, 200, 1400]) assert(getMissPenalty(0, 1, season) === 0 && getEffectiveMissMultiplier(0, 1, season) >= 0, `base 0 at ${season}`);
  // 199 -> 200: a 3-point habit's 2nd miss in a row goes from 1 (flat) to 3 (ceil 2.25).
  assert(getMissPenalty(3, 2, 199) === 1 && getMissPenalty(3, 2, 200) === 3, '199/200 boundary');
}

// 3. getMissPenalty: [base, misses, season, penalty, effective multiplier] (same table as the PGlite run).
{
  const cases: [number, number, number, number, number][] = [
    // Beginner: a flat 1, whatever the base or the run (effective 1 / base, 2 decimals).
    [1, 1, 0, 1, 1], [3, 3, 199, 1, 0.33], [2, 2, 100, 1, 0.5], [3, 1, 0, 1, 0.33], [1, 5, 199, 1, 1],
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
    assert(getEffectiveMissMultiplier(base, misses, season) === effective, `effective(${base}, ${misses}, ${season}) = ${effective}, got ${getEffectiveMissMultiplier(base, misses, season)}`);
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

// 5. Worked examples (marketing): a 3-point habit missed 3 days in a row by band.
{
  const run = (season: number) => [1, 2, 3].map((n) => getMissPenalty(3, n, season)).join(',');
  assert(run(0) === '1,1,1' && run(200) === '2,3,3' && run(1400) === '3,5,5', `3-pt runs ${run(0)} / ${run(200)} / ${run(1400)}`);
}

// 6. Rank-up line: only when the climb leaves Beginner.
{
  const idx = (name: string) => TIERS.findIndex((t) => t.name === name);
  assert(rankUpPenaltyNote(idx('Beginner'), idx('Starter')) === 'Misses now cost more (half until Achiever).', 'Beginner -> Starter');
  assert(rankUpPenaltyNote(idx('Beginner'), idx('Trainer')) === 'Misses now cost more (half until Achiever).', 'Beginner -> Trainer (jump)');
  assert(rankUpPenaltyNote(idx('Beginner'), idx('Achiever')) === 'Misses now cost their full points.', 'Beginner -> Achiever (jump): full, no "half"');
  assert(rankUpPenaltyNote(idx('Starter'), idx('Learner')) === null, 'Starter -> Learner: no line');
  assert(rankUpPenaltyNote(idx('Trainer'), idx('Achiever')) === null, 'Trainer -> Achiever: no line');
  assert(rankUpPenaltyNote(-1, 99) === null, 'bad indexes: no line');
}

console.log('missPenalty: all passed');
