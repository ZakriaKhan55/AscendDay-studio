// League results rules (lib/leagues/leagueResults.ts), decided 2026-11-24 with Zakria:
//   - shown as soon as the first server archive of an ENDED period exists (final or not);
//   - missing memory: baseline silently to the newest existing results (no backlog);
//   - only the newest unseen result per league; never again once seen, even if the archive changes;
//   - several at once: one list in order week, month, season;
//   - merge between devices: per league the newer period wins;
//   - card: place from the archive's userRank (ties), 1st / 2nd-3rd / 4th+ / alone tiers, top three,
//     delta against the previous period of the same league (never the other part of a season-cut week).
import {
  buildLeagueResultCard,
  decideLeagueResults,
  mergeLeagueResultsSeen,
} from '../leagues/leagueResults';
import { mergeAppState } from '../store/stateMerger';
import { DEFAULT_STATE, type LeagueArchive, type LeagueResultsSeen, type LeagueType } from '@/types';

function assert(condition: unknown, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) =>
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// Tue 2026-11-24 06:00 UTC: week W47 (Nov 16-22) and October have ended; W48, November and Season 1 run.
const NOW = Date.UTC(2026, 10, 24, 6);
// Mon 2027-02-01: Season 1 (from 2026-11-01, 90 days) has ended too.
const AFTER_SEASON = Date.UTC(2027, 1, 1, 6);
// Sat 2027-01-30 06:00 UTC: Season 1 ended six hours ago.
const SEASON_END = Date.UTC(2027, 0, 30, 6);

function archive(type: LeagueType, id: string, userRank: number, points: number[], extra: Partial<LeagueArchive> = {}): LeagueArchive {
  return {
    id,
    type,
    periodLabel: '',
    competitors: points.map((p, i) => ({
      id: `u${i}`,
      name: i === userRank - 1 ? 'me' : `m${i}`,
      avatar: '🦊',
      points: p,
      totalPoints: 0,
      ...(i === userRank - 1 ? { isUser: true } : {}),
    })),
    userRank,
    userPoints: points[userRank - 1],
    archivedAt: '2026-11-23T00:15:00.000Z',
    source: 'server',
    final: false,
    ...extra,
  };
}
const seen = (weekly: string | null, monthly: string | null, ninetyDay: string | null): LeagueResultsSeen => ({ weekly, monthly, ninetyDay });

const w46 = archive('weekly', 'W:2026-W46', 3, [500, 400, 300]);
const w47 = archive('weekly', 'W:2026-W47', 1, [464, 461, 200]);
const w48 = archive('weekly', 'W:2026-W48', 1, [50]); // running week (should never exist, but never shown early)
const oct = archive('monthly', 'M:2026-10', 2, [900, 800, 100]);
const s1 = archive('ninetyDay', 'S:1', 4, [5000, 4000, 3000, 2000, 10]);

// 1. Missing memory: baseline silently to the newest ended results; null where a league has none.
{
  const d = decideLeagueResults(null, [w46, w47, w48, oct], NOW);
  eq(d, { kind: 'baseline', memory: seen('W:2026-W47', 'M:2026-10', null) }, 'missing memory -> baseline to the newest ended result, running week ignored');
  const empty = decideLeagueResults(undefined, [], NOW);
  eq(empty, { kind: 'baseline', memory: seen(null, null, null) }, 'a new account baselines to nulls');
  // After a null baseline, the first result ever does show.
  const first = decideLeagueResults(seen(null, null, null), [w47], NOW);
  assert(first.kind === 'celebrate' && first.cards.length === 1 && first.cards[0].periodId === 'W:2026-W47', 'first result after a null baseline shows');
}

// 2. Provisional (final=false) archives count; client archives and running periods never do.
{
  const d = decideLeagueResults(seen('W:2026-W46', 'M:2026-10', null), [w46, w47, w48], NOW);
  assert(d.kind === 'celebrate', 'a provisional archive of an ended week shows');
  eq(d.kind === 'celebrate' && d.cards.map((c) => c.periodId), ['W:2026-W47'], 'only the ended week, not the running one');
  eq(d.kind === 'celebrate' && d.memory, seen('W:2026-W47', 'M:2026-10', null), 'memory moves to the shown week');
  const client = decideLeagueResults(seen('W:2026-W46', null, null), [w46, { ...w47, source: 'client' }], NOW);
  eq(client, { kind: 'none' }, 'a client-written archive never shows');
}

// 3. Only the newest unseen per league: an older missed one is skipped (stays in history).
{
  const d = decideLeagueResults(seen('W:2026-W45', null, null), [w46, w47], NOW);
  eq(d.kind === 'celebrate' && d.cards.map((c) => c.periodId), ['W:2026-W47'], 'only W47, not W46');
}

// 4. Seen once, never again: a recomputed archive (late logs) or a final flag changes nothing.
{
  const changed = { ...w47, userRank: 2, userPoints: 470, final: true };
  eq(decideLeagueResults(seen('W:2026-W47', 'M:2026-10', null), [w46, changed, oct], NOW), { kind: 'none' }, 'a changed archive of a seen week stays quiet');
  // Memory from another device that is ahead (newer week) is never undone.
  const ahead = decideLeagueResults(seen('W:2026-W48', 'M:2026-10', null), [w47, oct], NOW);
  eq(ahead, { kind: 'none' }, 'memory ahead of the archives shows nothing');
}

// 5. Several at once: one list in order week, month, season, whatever the archive order.
{
  // Season 1 ends Sat 2027-01-30 00:00 UTC and cuts the running week and month there too.
  const weekPart = archive('weekly', 'W:2027-W04@S1', 2, [80, 70]);
  const monthPart = archive('monthly', 'M:2027-01@S1', 1, [600, 300]);
  const d = decideLeagueResults(seen('W:2026-W46', 'M:2026-09', 'S:0'), [s1, monthPart, weekPart, w46], SEASON_END);
  assert(d.kind === 'celebrate', 'three leagues ended');
  eq(d.kind === 'celebrate' && d.cards.map((c) => c.type), ['weekly', 'monthly', 'ninetyDay'], 'week, month, then season');
  eq(d.kind === 'celebrate' && d.memory, seen('W:2027-W04@S1', 'M:2027-01@S1', 'S:1'), 'all three remembered');
  const season = d.kind === 'celebrate' ? d.cards[2] : null;
  eq(season?.seasonNumber, 1, 'season card knows its season');
}

// 5b. Only the period that just ended shows; someone back after a longer break gets no stale card.
{
  // Back on Tue 2026-12-08: W47 (Nov 16-22) and October are long over; marked seen silently.
  const later = Date.UTC(2026, 11, 8, 6);
  eq(
    decideLeagueResults(seen('W:2026-W46', 'M:2026-09', null), [w46, w47, oct], later),
    { kind: 'baseline', memory: seen('W:2026-W47', 'M:2026-10', null) },
    'stale week and month: no card, memory moves on'
  );
  // Week stale but November just ended (Dec 1-2): only the month card.
  const nov = archive('monthly', 'M:2026-11', 1, [1500, 900]);
  const d = decideLeagueResults(seen('W:2026-W46', 'M:2026-10', null), [w47, nov], Date.UTC(2026, 11, 2, 6));
  eq(d.kind === 'celebrate' && d.cards.map((c) => c.periodId), ['M:2026-11'], 'only the just-ended month shows');
  eq(d.kind === 'celebrate' && d.memory, seen('W:2026-W47', 'M:2026-11', null), 'the stale week is marked seen too');
  // A season result stays fresh for the whole next season.
  const s = decideLeagueResults(seen(null, null, 'S:0'), [s1], AFTER_SEASON + 60 * 86_400_000);
  eq(s.kind === 'celebrate' && s.cards.map((c) => c.periodId), ['S:1'], 'season result still shows 60 days into the next season');
}

// 6. Merge between devices: per league the newer period wins; missing/invalid sides lose.
{
  eq(mergeLeagueResultsSeen(null, seen('W:2026-W47', null, null)), seen('W:2026-W47', null, null), 'nothing + memory = memory');
  eq(mergeLeagueResultsSeen(seen('W:2026-W47', null, null), undefined), seen('W:2026-W47', null, null), 'memory + nothing = memory');
  eq(mergeLeagueResultsSeen(null, null), null, 'nothing on both sides');
  eq(
    mergeLeagueResultsSeen(seen('W:2026-W47', 'M:2026-09', null), seen('W:2026-W46', 'M:2026-10', 'S:1')),
    seen('W:2026-W47', 'M:2026-10', 'S:1'),
    'per league the newer period wins'
  );
  eq(
    mergeLeagueResultsSeen(seen('W:2026-W52', null, null), seen('W:2027-W01', null, null)),
    seen('W:2027-W01', null, null),
    'across a year end the later week wins (not string order)'
  );
  // A week cut by a season start: the in-season part ends later than the @S part.
  eq(
    mergeLeagueResultsSeen(seen('W:2027-W04', null, null), seen('W:2027-W04@S1', null, null)),
    seen('W:2027-W04', null, null),
    'the in-season part of a cut week is newer than its @S part'
  );
  eq(
    mergeLeagueResultsSeen(seen('junk' as string, 'M:2026-10', null), seen(null, null, null)),
    seen(null, 'M:2026-10', null),
    'an invalid id counts as nothing'
  );
  // The settings doc merge carries it (two devices converge through the blob).
  const merged = mergeAppState(
    { ...DEFAULT_STATE, leagueResultsSeen: seen('W:2026-W46', 'M:2026-10', null) },
    { ...DEFAULT_STATE, leagueResultsSeen: seen('W:2026-W47', 'M:2026-09', null) }
  );
  eq(merged.leagueResultsSeen, seen('W:2026-W47', 'M:2026-10', null), 'mergeAppState keeps the newer period per league');
}

// 7. Cards: tiers, ties, alone, podium, delta.
{
  const firstCard = buildLeagueResultCard(w47, w46);
  eq([firstCard.tier, firstCard.place, firstCard.of, firstCard.points], ['first', 1, 3, 464], '1st of 3');
  eq(firstCard.delta, { places: 2, points: 164 }, 'up 2 places, +164 on last week');
  eq(firstCard.podium.map((p) => [p.place, p.points, p.isUser]), [[1, 464, true], [2, 461, false], [3, 200, false]], 'top three in archive order');

  eq(buildLeagueResultCard(archive('weekly', 'W:2026-W47', 2, [300, 300, 10]), null).tier, 'podium', 'a tie follows the archive userRank (2nd)');
  eq(buildLeagueResultCard(archive('weekly', 'W:2026-W47', 3, [3, 2, 1]), null).tier, 'podium', '3rd is a medal');
  const fourth = buildLeagueResultCard(archive('weekly', 'W:2026-W47', 4, [9, 8, 7, 6, 5]), null);
  eq([fourth.tier, fourth.delta], ['calm', null], '4th is calm; no previous period, no delta');
  const alone = buildLeagueResultCard(archive('weekly', 'W:2026-W47', 1, [120]), null);
  eq([alone.tier, alone.alone, alone.of], ['calm', true, 1], 'alone on the board is calm, not a win');

  // The previous period is the last whole one, never the @S part of the same week.
  const cutPart = archive('weekly', 'W:2027-W04@S1', 1, [40, 10]);
  const cutWeek = archive('weekly', 'W:2027-W04', 2, [90, 80, 5]);
  const w03 = archive('weekly', 'W:2027-W03', 1, [70, 60]);
  const d = decideLeagueResults(seen('W:2027-W04@S1', null, null), [cutPart, cutWeek, w03], Date.UTC(2027, 1, 2));
  const card = d.kind === 'celebrate' ? d.cards[0] : null;
  eq(card?.periodId, 'W:2027-W04', 'the in-season part of a cut week shows after its @S part');
  eq(card?.delta, { places: -1, points: 10 }, 'delta against W03, not the @S part');
}

console.log('leagueResults: all passed');
