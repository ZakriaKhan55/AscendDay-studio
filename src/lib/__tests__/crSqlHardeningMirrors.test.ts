// CodeRabbit phase 5 (knowledge/mode-a-cr-p5-sql-2026-11-14.md): the app's point previews that
// mirror 20261114130000_coderabbit_sql_hardening.sql (work/cr-p5-sql/pg/t.mjs runs the SQL cases).
// CR-05-17 season-split week keeps the frozen row's goals; CR-10-2 resist allocation in two passes;
// CR-09-23 slip multiplier ignores a stale resist row; CR-10-13 focus award stays on its day.
import { DEFAULT_STATE, type AppState, type BadHabit, type BadHabitLog, type FocusSessionLog, type PointsEntry, type WeeklyGoalItem } from '@/types';
import { recomputeWeeklyGoalsPointsForState } from '../points/weeklyGoalPoints';
import { isWeeklyGoalSeasonSplitEntryId } from '../leagues/weeklyGoalSeasons';
import { badHabitResistId, computeBadHabitAwards } from '../points/badHabitAwards';
import { computeFocusAwards } from '../points/focusAwards';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(a === b, `${msg} (got ${String(a)}, want ${String(b)})`);

// ---------------------------------------------------------------- CR-05-17 (mirror of CR-09-24)
// 2026-W44 holds the Season 1 start (2026-11-01 00:00 UTC) in every zone the tests run in.
{
  const WEEK = '2026-W44';
  const BEFORE = '2026-10-30T12:00:00.000Z';
  const AFTER = '2026-11-01T12:00:00.000Z';
  const goal = (id: string, at: string, done = true): WeeklyGoalItem => ({
    id, title: id, priority: 'medium', completed: done, done, completedAt: done ? at : undefined, createdAt: BEFORE,
  });
  const base: PointsEntry = {
    id: `weekly_goal_${WEEK}`, amount: 10, reason: 'r', source: 'weekly_goal_achieved', timestamp: BEFORE,
    metadata: { weekKey: WEEK, countedGoalsCount: 2, completedGoalsCount: 2, counted: [{ id: 'A', at: BEFORE }, { id: 'B', at: BEFORE }] },
  };
  const split = (goals: WeeklyGoalItem[]) => {
    const st = { ...DEFAULT_STATE, pointsHistory: [base] } as AppState;
    const out = recomputeWeeklyGoalsPointsForState(st, WEEK, goals);
    return (out.pointsHistory || st.pointsHistory).find((e) => e && isWeeklyGoalSeasonSplitEntryId(e.id))?.amount ?? 0;
  };
  eq(split([goal('A', BEFORE, false), goal('B', BEFORE), goal('C', AFTER)]), 5, 'frozen goal A unticked after the boundary: C still earns 5');
  eq(split([goal('B', BEFORE), goal('C', AFTER)]), 5, 'frozen goal A deleted: C still earns 5');
  eq(split([goal('A', BEFORE), goal('B', BEFORE), goal('C', AFTER)]), 5, 'control: nothing unticked, 5');
  eq(split([goal('A', BEFORE), goal('B', BEFORE), goal('C', AFTER), goal('D', AFTER)]), 5, 'control: cap 3 goals, 5');
  eq(split([goal('A', BEFORE), goal('B', BEFORE)]), 0, 'control: nothing after the boundary, no season row');
}

// ---------------------------------------------------------------- bad habits
const DAY = '2026-11-14';
const START = new Date(`${DAY}T00:00:00`).getTime();
const NOW = START + 20 * 3600_000;
const at = (h: number) => new Date(START + h * 3600_000).toISOString();
const bh = (id: string, name: string): BadHabit => ({ id, name, isPreset: true, createdAt: new Date(START - 86400_000).toISOString() });
const log = (id: string, badHabitId: string, hour: number, status: BadHabitLog['status'] = 'resisted'): BadHabitLog => ({
  id, badHabitId, date: DAY, status, pointsAwardedOrDeducted: 0, createdAt: at(hour),
});
const row = (id: string, amount: number, source: string, extra: Partial<PointsEntry> = {}): PointsEntry => ({
  id, amount, reason: '', source, timestamp: at(1), ...extra,
});
const byHabit = (entries: PointsEntry[], source: string) =>
  Object.fromEntries(entries.filter((e) => e.source === source).map((e) => [e.metadata?.badHabitId, e.amount]));

// CR-10-2: every resist already earned (A 1, B 3, C 2; A logged first on an offline device).
{
  const habits = [bh('A', 'Porn'), bh('B', 'Smoking / vaping'), bh('C', 'Doomscrolling')];
  const logs = [log('la', 'A', 1), log('lb', 'B', 2), log('lc', 'C', 3)];
  const earned = (id: string, amount: number) =>
    row(badHabitResistId(id, DAY), amount, 'bad_habit_resisted', { metadata: { badHabitId: id, date: DAY, status: 'resisted' } });
  const r = byHabit(computeBadHabitAwards(habits, logs, [earned('A', 1), earned('B', 3), earned('C', 2)], DAY, START, NOW, 0).entries, 'bad_habit_resisted');
  assert(r.A === 1 && r.B === 3 && r.C === 2, `each keeps what it earned (got ${JSON.stringify(r)})`);
  const fresh = byHabit(computeBadHabitAwards(habits, logs, [], DAY, START, NOW, 0).entries, 'bad_habit_resisted');
  assert(fresh.A === 3 && fresh.B === 3 && !('C' in fresh), `control: fresh day in log order (got ${JSON.stringify(fresh)})`);
  const topUp = byHabit(computeBadHabitAwards(habits, logs.slice(0, 2), [earned('A', 1), earned('B', 3)], DAY, START, NOW, 0).entries, 'bad_habit_resisted');
  assert(topUp.A === 3 && topUp.B === 3, `room left: A tops up to its points (got ${JSON.stringify(topUp)})`);
}

// CR-09-23: 1998 season points + today's resist row (3) whose log is now a slip; 2 bad days in a row.
{
  const sum = (history: PointsEntry[]) => history.reduce((t, e) => t + (e?.amount || 0), 0);
  const history = [
    row('big', 1998, 'habit_completed'),
    row(badHabitResistId('X', DAY), 3, 'bad_habit_resisted', { metadata: { badHabitId: 'X', date: DAY, status: 'resisted' } }),
  ];
  const slip = (h: PointsEntry[]) =>
    byHabit(computeBadHabitAwards([bh('X', 'Porn')], [log('lx', 'X', 5, 'occurred')], h, DAY, START, NOW, sum).entries, 'bad_habit_occurred').X;
  eq(slip(history), -5, 'stale resist left out: 1998 pts, 1.5x, -5');
  eq(slip([row('big', 2001, 'habit_completed')]), -6, 'control: 2001 real pts, 2x, -6');
  eq(
    byHabit(computeBadHabitAwards([bh('X', 'Porn')], [log('lx', 'X', 5, 'occurred')], history, DAY, START, NOW, 2001).entries, 'bad_habit_occurred').X,
    -6,
    'a plain number is used as given'
  );
}

// ---------------------------------------------------------------- CR-10-13
{
  const MIN = 60_000;
  const PREV = '2026-11-13';
  const mid = new Date(`${DAY}T00:00:00`).getTime();
  const crossing: FocusSessionLog = {
    id: 'f1', date: DAY, taskName: 'Work', durationMinutes: 25, pointsAwarded: 0,
    createdAt: new Date(mid + 5 * MIN).toISOString(), plannedMinutes: 25,
    startedAt: new Date(mid - 25 * MIN).toISOString(), milestonesAt: [new Date(mid).toISOString()], pointsRule: 2,
  };
  const prevStart = new Date(`${PREV}T00:00:00`).getTime();
  const entry = computeFocusAwards([crossing], PREV, prevStart, mid + 60 * MIN).entry;
  eq(entry?.amount, 2, '25 min before midnight earn 2 on the day before');
  assert(entry !== null && new Date(entry.timestamp).getTime() === mid - 1, `stamped at the day's last ms, not next midnight (got ${entry?.timestamp})`);
  const early: FocusSessionLog = { ...crossing, id: 'f2', date: PREV, createdAt: new Date(mid - 10 * MIN).toISOString(),
    startedAt: new Date(mid - 40 * MIN).toISOString(), milestonesAt: [new Date(mid - 15 * MIN).toISOString()] };
  const e2 = computeFocusAwards([early], PREV, prevStart, mid + 60 * MIN).entry;
  assert(e2 !== null && new Date(e2.timestamp).getTime() < mid - 1, 'control: an earlier stamp is unchanged');
}

console.log('crSqlHardeningMirrors: all passed');
