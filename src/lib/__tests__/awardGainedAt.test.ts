// "Reached first" stamp (2026-11-18): the 5 one-row-per-day award mirrors stamp data.gainedAt as
// ascend_award_gained_at does (supabase/migrations/20261118133000_award_gained_at.sql; SQL side proved in
// work/fix-gained-at/pglite-gained-at.mjs). Now when the existing row's amount rises; kept otherwise;
// none on a new row. The row's timestamp never moves, so totals and periods never change.
import type { FocusSessionLog, PointsEntry, ReadingLog, SkillSessionLog, Skill, TimeTrackerBlock, UserBook, WorkoutLog } from '@/types';
import { awardGainedAt } from '../points/awardGainedAt';
import { computeWorkoutAwards } from '../points/workoutAwards';
import { computeSkillAwards } from '../points/skillAwards';
import { computeFocusAwards } from '../points/focusAwards';
import { computeTimeTrackerAward } from '../points/timeTrackerAwards';
import { computeReadingDayAward } from '../points/readingAwards';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(Object.is(a, b), `${msg} (got ${String(a)}, want ${String(b)})`);

const DAY = '2026-11-18';
const START = new Date(`${DAY}T00:00:00`).getTime();
const NOW = START + 20 * 3600_000;
const NOW_ISO = new Date(NOW).toISOString();
const at = (h: number) => new Date(START + h * 3600_000).toISOString();
const row = (id: string, amount: number, extra: Partial<PointsEntry> = {}): PointsEntry => ({
  id, amount, reason: 'x', source: 'x', timestamp: at(8), metadata: { date: DAY }, ...extra,
});

// 1. The helper, case by case (same table as the SQL helper).
eq(awardGainedAt(null, 5, NOW), undefined, 'no live row: none');
eq(awardGainedAt(undefined, 5, NOW), undefined, 'undefined row: none');
eq(awardGainedAt(row('a', 3), 5, NOW), NOW_ISO, 'rise: now');
eq(awardGainedAt(row('a', 5), 5, NOW), undefined, 'equal, never raised: none');
eq(awardGainedAt(row('a', 5, { gainedAt: at(9) }), 5, NOW), at(9), 'equal: kept');
eq(awardGainedAt(row('a', 7, { gainedAt: at(9) }), 5, NOW), at(9), 'fall: kept, not moved');
eq(awardGainedAt(row('a', 3, { gainedAt: at(9) }), 5, NOW), NOW_ISO, 'second rise: moves to now');
eq(awardGainedAt({ ...row('a', 3), amount: NaN }, 5, NOW), undefined, 'non-number amount: no rise');
eq(NOW_ISO.length, 24, 'ISO with milliseconds, the data.timestamp format');

// 2. Workout: a later workout raises the day's row.
const wo = (id: string, h: number, mins: number): WorkoutLog => ({
  id, date: DAY, type: 'Run', durationMinutes: mins, unit: 'mins', amount: mins, pointsAwarded: 0, createdAt: at(h),
});
{
  const first = computeWorkoutAwards([wo('w1', 8, 20)], DAY, START, NOW).entry!;
  eq(first.gainedAt, undefined, 'workout: new row has no gainedAt');
  const second = computeWorkoutAwards([wo('w1', 8, 20), wo('w2', 19, 20)], DAY, START, NOW, first).entry!;
  assert(second.amount > first.amount, 'workout: second log raises');
  eq(second.gainedAt, NOW_ISO, 'workout: rise stamps gainedAt now');
  eq(second.timestamp, first.timestamp, 'workout: timestamp kept');
  const same = computeWorkoutAwards([wo('w1', 8, 20), wo('w2', 19, 20)], DAY, START, NOW + 3600_000, second).entry!;
  eq(same.gainedAt, NOW_ISO, 'workout: no rise keeps gainedAt');
  const fell = computeWorkoutAwards([wo('w1', 8, 20)], DAY, START, NOW + 3600_000, second).entry!;
  eq(fell.gainedAt, NOW_ISO, 'workout: a fall keeps gainedAt');
  eq(fell.timestamp, first.timestamp, 'workout: a fall keeps timestamp');
  const otherDay = computeWorkoutAwards([wo('w1', 8, 20), wo('w2', 19, 20)], DAY, START, NOW, row('workout_award_2026-11-17', 1)).entry!;
  eq(otherDay.gainedAt, undefined, 'workout: another day row is not the kept row');
}

// 3. Skill: same, plus floor mode (yesterday raised by a late session).
{
  const skills: Skill[] = [{ id: 'sk', name: 'Guitar' } as Skill];
  const sl = (id: string, h: number, mins: number): SkillSessionLog => ({ id, skillId: 'sk', date: DAY, durationMinutes: mins, createdAt: at(h) } as SkillSessionLog);
  const first = computeSkillAwards([sl('s1', 8, 30)], skills, DAY, START, NOW).entry!;
  eq(first.gainedAt, undefined, 'skill: new row has no gainedAt');
  const up = computeSkillAwards([sl('s1', 8, 30), sl('s2', 18, 30)], skills, DAY, START, NOW, first).entry!;
  assert(up.amount > first.amount, 'skill: second session raises');
  eq(up.gainedAt, NOW_ISO, 'skill: rise stamps gainedAt');
  eq(up.timestamp, first.timestamp, 'skill: timestamp kept');
  const floorUp = computeSkillAwards([sl('s1', 8, 30), sl('s2', 18, 30)], skills, DAY, START, NOW, first, { floor: true }).entry!;
  eq(floorUp.gainedAt, NOW_ISO, 'skill floor: rise stamps gainedAt');
  const floorSame = computeSkillAwards([sl('s1', 8, 30)], skills, DAY, START, NOW, up, { floor: true }).entry!;
  assert(floorSame === up, 'skill floor: no rise returns the kept row as it is');
}

// 4. Focus: old-tier sessions (pointsRule unset) on one day.
{
  const fl = (id: string, h: number, mins: number): FocusSessionLog => ({ id, date: DAY, taskName: 'Old', durationMinutes: mins, pointsAwarded: 0, createdAt: at(h) });
  const first = computeFocusAwards([fl('f1', 9, 25)], DAY, START, NOW).entry!;
  eq(first.gainedAt, undefined, 'focus: new row has no gainedAt');
  const up = computeFocusAwards([fl('f1', 9, 25), fl('f2', 15, 50)], DAY, START, NOW, first).entry!;
  assert(up.amount > first.amount, 'focus: second session raises');
  eq(up.gainedAt, NOW_ISO, 'focus: rise stamps gainedAt');
  eq(up.timestamp, first.timestamp, 'focus: timestamp kept');
  const floorSame = computeFocusAwards([fl('f1', 9, 25)], DAY, START, NOW, up, { floor: true }).entry!;
  assert(floorSame === up, 'focus floor: no rise returns the kept row');
}

// 5. Time tracker: 3 -> 5 stamps; 5 -> 3 keeps; a percentage-only change keeps.
{
  const blocks = (done: number, total: number): TimeTrackerBlock[] =>
    Array.from({ length: total }, (_, i) => ({ id: `b${i}`, startTime: '09:00', endTime: '10:00', activityId: 'a', completed: i < done } as TimeTrackerBlock));
  const three = computeTimeTrackerAward(blocks(3, 5), DAY, NOW - 3600_000)!;
  eq(three.amount, 3, 'tt: 60% = 3');
  eq(three.gainedAt, undefined, 'tt: new row has no gainedAt');
  const five = computeTimeTrackerAward(blocks(5, 5), DAY, NOW, three)!;
  eq(five.amount, 5, 'tt: 100% = 5');
  eq(five.gainedAt, NOW_ISO, 'tt: rise stamps gainedAt');
  eq(five.timestamp, three.timestamp, 'tt: timestamp kept');
  const four = computeTimeTrackerAward(blocks(4, 5), DAY, NOW + 3600_000, five)!;
  eq(four.amount, 5, 'tt: 80% still 5');
  eq(four.gainedAt, NOW_ISO, 'tt: percentage-only change keeps gainedAt');
  const back = computeTimeTrackerAward(blocks(3, 5), DAY, NOW + 7200_000, four)!;
  eq(back.gainedAt, NOW_ISO, 'tt: fall keeps gainedAt');
}

// 6. Reading: a later log raises the day's page award; floor mode with no rise keeps the row.
{
  const books = [{ id: 'b1', unit: 'pages', status: 'reading' } as unknown as UserBook];
  const rlog = (id: string, h: number, pages: number): ReadingLog => ({ id, bookId: 'b1', date: DAY, pagesRead: pages, createdAt: at(h) });
  const first = computeReadingDayAward([rlog('r1', 8, 6)], books, DAY, START, NOW).entry!;
  eq(first.amount, 3, 'reading: 6 pages = 3');
  eq(first.gainedAt, undefined, 'reading: new row has no gainedAt');
  const up = computeReadingDayAward([rlog('r1', 8, 6), rlog('r2', 18, 6)], books, DAY, START, NOW, first).entry!;
  eq(up.amount, 6, 'reading: 12 pages = 6');
  eq(up.gainedAt, NOW_ISO, 'reading: rise stamps gainedAt');
  eq(up.timestamp, first.timestamp, 'reading: timestamp kept');
  const floorSame = computeReadingDayAward([rlog('r1', 8, 6)], books, DAY, START, NOW, up, { floor: true }).entry!;
  assert(floorSame === up, 'reading floor: no rise returns the kept row');
}

console.log('awardGainedAt: all checks passed');
