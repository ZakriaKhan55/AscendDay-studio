// 1.8.0 penalties by rank: the Habits and Bad habits rows' "next miss" hint follows getMissPenalty
// (SQL ascend_miss_penalty). Beginner says no points are lost yet and never shows "−0"; Starter to
// Trainer shows half (rounded up); Achiever the full amount.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { BadHabit, Habit } from '@/types';
import { HabitRow } from '../habits/HabitRow';
import { BadHabitSlipWarning } from '../badHabits/BadHabitRow';
import { addDays, todayKey } from '@/lib/time/dates';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const textOf = (html: string) => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').replace(/ \./g, '.');

const today = todayKey();
const daysAgo = (n: number) => new Date(`${addDays(today, -n)}T12:00:00`).toISOString();

// A 2-point library habit added 3 days ago and never ticked: 3 misses so far, today would be the 4th.
const habit = {
  id: 'h1',
  name: 'Read 20 pages',
  isPreset: true,
  points: 2,
  frequency: 'daily',
  createdAt: daysAgo(3),
  completions: {},
} as unknown as Habit;
const row = (seasonPoints: number) =>
  textOf(renderToString(createElement(HabitRow, { habit, done: false, seasonPoints, popClass: '', onToggle: () => undefined, onDelete: () => undefined })));

{
  const beginner = row(0);
  assert(/in a row\. No points lost yet: misses cost points from Starter\./.test(beginner), `Beginner habit hint: ${beginner}`);
  assert(!beginner.includes('−0') && !beginner.includes('costs'), 'Beginner habit hint: no "−0" and no cost');
  // 4th miss: 2 x 1.5 = 3; half -> 1.5 -> 2.
  assert(/Missing today costs −2 pts\./.test(row(200)), `Starter habit hint −2: ${row(200)}`);
  assert(/Missing today costs −3 pts\./.test(row(1400)), `Achiever habit hint −3: ${row(1400)}`);
  assert(/Missing today costs −5 pts\./.test(row(2000)), `Performer habit hint −5 (2.5x): ${row(2000)}`);
}

// A 3-point library bad habit (Porn) added 2 days ago, never logged: 2 bad days, today would be the 3rd.
const bad = { id: 'b1', name: 'Porn', isPreset: true, createdAt: daysAgo(2) } as unknown as BadHabit;
const warning = (seasonPoints: number) =>
  textOf(renderToString(createElement(BadHabitSlipWarning, { habit: bad, logs: [], today, logged: false, seasonPoints })));
{
  const beginner = warning(0);
  assert(/2 bad days in a row\. No points lost yet: slips cost points from Starter\./.test(beginner), `Beginner slip hint: ${beginner}`);
  assert(!beginner.includes('−0') && !beginner.includes('costs'), 'Beginner slip hint: no "−0" and no cost');
  // 3rd bad day: 3 x 1.5 = 4.5; half -> 2.25 -> 3; full -> 5.
  assert(/Slipping today costs −3 pts\./.test(warning(1399)), `Trainer slip hint −3: ${warning(1399)}`);
  assert(/Slipping today costs −5 pts\./.test(warning(1400)), `Achiever slip hint −5: ${warning(1400)}`);
}

console.log('missHints: all passed');
