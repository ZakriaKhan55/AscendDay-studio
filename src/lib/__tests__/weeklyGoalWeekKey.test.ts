// CR-05-16: extractWeekKeyFromWeeklyGoalEntry falls back to the week key inside the row id when
// metadata.weekKey is missing. `\b` never matched after the `_` in `weekly_goal_<week>`, so that
// fallback was dead; the key is now bounded by `_` or the id's ends.
import type { PointsEntry } from '@/types';
import { extractWeekKeyFromWeeklyGoalEntry, groupWeeklyGoalEntriesByWeekKey } from '../points/weeklyGoalPoints';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(a === b, `${msg} (got ${String(a)}, want ${String(b)})`);

const AT = 'Mon 2026-11-09 5:00 PM PKT (UTC+05:00)';
const entry = (id: string, extra: Partial<PointsEntry> = {}): PointsEntry =>
  ({ id, amount: 10, reason: 'Weekly goals', source: 'weekly_goal_achieved', timestamp: AT, ...extra }) as PointsEntry;

// Fallback on the id (no metadata.weekKey, no week in the reason).
eq(extractWeekKeyFromWeeklyGoalEntry(entry('weekly_goal_2026-W46')), '2026-W46', 'base row id gives its week');
eq(extractWeekKeyFromWeeklyGoalEntry(entry('weekly_goal_2026-W44_s1')), '2026-W44', 'season-split row id gives its week');

// Controls: metadata wins, the reason fallback is unchanged, nothing is invented.
eq(extractWeekKeyFromWeeklyGoalEntry(entry('weekly_goal_2026-W46', { metadata: { weekKey: '2026-W45' } })), '2026-W45', 'metadata.weekKey wins over the id');
eq(extractWeekKeyFromWeeklyGoalEntry(entry('x1', { reason: 'Weekly goals 2026-W40 done' })), '2026-W40', 'reason fallback unchanged');
eq(extractWeekKeyFromWeeklyGoalEntry(entry('weekly_goal_x2026-W46')), null, 'week glued to other text is not taken');
eq(extractWeekKeyFromWeeklyGoalEntry(entry('weekly_goal_2026-W466')), null, 'longer week number is not taken');
eq(extractWeekKeyFromWeeklyGoalEntry(entry('reading_2026-W46', { source: 'reading' })), null, 'non weekly-goal row is ignored');

// Grouping uses it: a row without metadata joins its week instead of "other" history.
const { weeklyGoalsMap, otherHistory } = groupWeeklyGoalEntriesByWeekKey([entry('weekly_goal_2026-W46')]);
eq(weeklyGoalsMap.get('2026-W46')?.length ?? 0, 1, 'grouped under its week');
eq(otherHistory.length, 0, 'not left in other history');

console.log('weeklyGoalWeekKey: all passed');
