// habitsDueToday (lib/weeklyActivity.ts): the Dashboard's "today" (ring + "All done for today")
// counts every daily habit, and a weekly habit only once it is done this week or on Sunday.
import type { Habit } from '@/types';
const { habitsDueToday, dailyHabitCompletions } = await import('../time/weeklyActivity');
const { periodKey, previousPeriodKey, calculateStreak } = await import('../time/dates');

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const ids = (list: Habit[]) => list.map((h) => h.id).join(',');

const habit = (id: string, frequency: 'daily' | 'weekly'): Habit => ({
  id,
  name: id,
  frequency,
  points: 1,
  isPreset: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  createdAtPeriod: '2026-11-01',
  completions: {},
});

const daily = habit('daily', 'daily');
const weeklyOpen = habit('weeklyOpen', 'weekly');
const weeklyDone = habit('weeklyDone', 'weekly');
const done = new Set(['weeklyDone']);
const isDone = (h: Habit) => done.has(h.id);
const all = [daily, weeklyOpen, weeklyDone];

// 2026-11-11 is a Wednesday, 2026-11-15 a Sunday, 2026-11-16 a Monday.
assert(ids(habitsDueToday(all, isDone, '2026-11-11')) === 'daily,weeklyDone', 'midweek: open weekly habit waits');
assert(ids(habitsDueToday(all, isDone, '2026-11-16')) === 'daily,weeklyDone', 'Monday: open weekly habit waits');
assert(ids(habitsDueToday(all, isDone, '2026-11-15')) === 'daily,weeklyOpen,weeklyDone', 'Sunday: every weekly habit is due');
assert(habitsDueToday([weeklyOpen], isDone, '2026-11-11').length === 0, 'only an open weekly habit midweek: nothing due');
assert(habitsDueToday([], isDone, '2026-11-15').length === 0, 'no habits');
// Order is kept (the Today card order).
assert(ids(habitsDueToday([weeklyDone, daily], isDone, '2026-11-11')) === 'weeklyDone,daily', 'order kept');

// A habit with no frequency (legacy row) counts as daily, as in SQL coalesce(frequency, 'daily').
const noFreq = { ...habit('noFreq', 'daily'), frequency: undefined, completions: { '2026-11-11': { done: true, updatedAt: '' } } } as unknown as Habit;
const perDay = dailyHabitCompletions([noFreq], ['2026-11-10', '2026-11-11']);
assert(perDay[0].total === 1 && perDay[0].done === 0 && perDay[1].total === 1 && perDay[1].done === 1, 'missing frequency counted as a daily habit');
const wed = new Date(2026, 10, 11, 12);
assert(periodKey(noFreq.frequency, wed) === '2026-11-11', 'missing frequency: period key is the day');
assert(previousPeriodKey(noFreq.frequency, 1, wed) === '2026-11-10', 'missing frequency: previous period is yesterday');
assert(calculateStreak(['2026-11-10', '2026-11-11'], noFreq.frequency, wed) === 2, 'missing frequency: streak counts days');

console.log('habitsDueToday: all passed');
