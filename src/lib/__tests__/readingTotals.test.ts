// Shown reading totals (Reading chart, linked weekly goals) count pages logged twice from the same
// place once, by the same covered-range rule as the page award (countedReadingAmounts, 2026-11-18).
// Mutation proof: with the old linkedGoalMetrics (raw pagesRead) the two-device goal reads 20, not
// 10; with coverReadingDayEvents returning every log's full amount the counted totals fail too.
import type { AppState, ReadingLog, UserBook, WeeklyGoalItem } from '@/types';
import fixtures from './fixtures/readingRanges.json';
import { computeReadingDayAward, countedReadingAmounts, logPageAmount } from '../points/readingAwards';
import { LINKED_GOAL_METRICS } from '../items/linkedGoalMetrics';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (got: number, want: number, msg: string) => assert(Math.abs(got - want) < 1e-9, `${msg}: got ${got}, expected ${want}`);

const DAY = '2026-11-18';
const DAY2 = '2026-11-19';
const READ1 = '2026-11-01T10:00:00.000Z';
const READ2 = '2026-11-18T09:00:00.000Z';
const pagesBook: UserBook = { id: 'b1', unit: 'pages', status: 'reading' } as UserBook;
const chapterBook: UserBook = { id: 'c1', unit: 'chapters', status: 'reading' } as UserBook;

let n = 0;
const log = (over: Partial<ReadingLog>): ReadingLog => ({
  id: `l${++n}`,
  bookId: 'b1',
  date: DAY,
  pagesRead: 10,
  unit: 'pages',
  createdAt: `${DAY}T0${Math.min(n, 9)}:00:00.000Z`,
  ...over,
});
const total = (logs: ReadingLog[], books: UserBook[]) => {
  const counted = countedReadingAmounts(logs, books);
  return logs.reduce((sum, l) => sum + (counted.get(l) ?? 0), 0);
};

// 1. Two devices 20 -> 30 from the same place: 10 pages, not 20.
const twoDevices = [
  log({ fromAmount: 20, readStartedAt: READ1 }),
  log({ fromAmount: 20, readStartedAt: READ1 }),
];
eq(total(twoDevices, [pagesBook]), 10, 'two devices 20->30 show 10 pages');

// 2. Partial overlap: 20 -> 30 and 25 -> 35 = pages 20..35.
eq(total([log({ fromAmount: 20, readStartedAt: READ1 }), log({ fromAmount: 25, readStartedAt: READ1 })], [pagesBook]), 15, 'overlap 20->30 + 25->35 = 15');

// 3. Old logs (no fromAmount, app 1.4.1) count in full, as before.
eq(total([log({}), log({})], [pagesBook]), 20, 'logs without fromAmount count in full');
eq(total([log({ fromAmount: 20, readStartedAt: READ1 }), log({})], [pagesBook]), 20, 'one old log beside a ranged one counts in full');

// 4. Read again: a new read (readStartedAt) counts the same pages again.
eq(total([log({ fromAmount: 0, readStartedAt: READ1 }), log({ fromAmount: 0, readStartedAt: READ2 })], [pagesBook]), 20, 're-read counts again');

// 5. Another day: the same range counts again (covered ranges are per day).
eq(total([log({ fromAmount: 20, readStartedAt: READ1 }), log({ fromAmount: 20, readStartedAt: READ1, date: DAY2 })], [pagesBook]), 20, 'another day counts again');

// 6. Another book: never deduped against this one.
eq(total([log({ fromAmount: 20, readStartedAt: READ1 }), log({ bookId: 'b2', fromAmount: 20, readStartedAt: READ1 })], [pagesBook, { ...pagesBook, id: 'b2' }]), 20, 'other book counts');

// 7. Chapters: 1.0 -> 1.3 on two devices = 0.3 chapters (in whole tenths).
const chap = (over: Partial<ReadingLog>) => log({ bookId: 'c1', unit: 'chapters', pagesRead: 0.3, fromAmount: 1, readStartedAt: READ1, ...over });
const chapLogs = [chap({}), chap({})];
eq(total(chapLogs, [chapterBook]), 0.3, 'two devices 1.0->1.3 show 0.3 chapters');
eq(total([chap({}), chap({ fromAmount: 1.1, pagesRead: 0.3 })], [chapterBook]), 0.4, 'chapters 1.0->1.3 + 1.1->1.4 = 0.4');

// 8. Unit switch between two logs starts the covered ranges over (as for points).
const switched: UserBook = {
  ...pagesBook,
  unitSwitches: [{ date: DAY, at: `${DAY}T05:00:00.000Z`, pagesBefore: 30, pagesAfter: 30 }],
};
const aroundSwitch = [
  log({ fromAmount: 20, readStartedAt: READ1, createdAt: `${DAY}T04:00:00.000Z` }),
  log({ fromAmount: 20, readStartedAt: READ1, createdAt: `${DAY}T06:00:00.000Z` }),
];
eq(total(aroundSwitch, [switched]), 20, 'a unit switch clears the covered ranges');
eq(total(aroundSwitch, [pagesBook]), 10, 'same logs without the switch: 10');

// 9. A Finish log counts in full and covers nothing.
eq(total([log({ fromAmount: 20, readStartedAt: READ1, finish: true }), log({ fromAmount: 20, readStartedAt: READ1 })], [pagesBook]), 20, 'finish log counts in full');

// 10. A log whose book is gone keeps counting (among its own book's logs).
eq(total([log({ bookId: 'gone', fromAmount: 20, readStartedAt: READ1 }), log({ bookId: 'gone', fromAmount: 20, readStartedAt: READ1 })], []), 10, 'gone book still deduped among itself');

// 11. Linked weekly goals use the counted amounts.
const goal = (key: 'pages_read' | 'chapters_read', linkedItemId?: string): WeeklyGoalItem =>
  ({ id: 'g', title: 'g', priority: 'medium', linkedModule: 'reading', linkedItemId, linkedMetricKey: key, completed: false, createdAt: DAY }) as WeeklyGoalItem;
const goalSum = (logs: ReadingLog[], books: UserBook[], g: WeeklyGoalItem) => {
  const def = LINKED_GOAL_METRICS.reading.find((d) => d.key === g.linkedMetricKey)!;
  const state = { readingLogs: logs, libraryBooks: books } as unknown as AppState;
  return def.entries(state, g, [DAY, DAY2]).reduce((s, e) => s + e.value, 0);
};
eq(goalSum(twoDevices, [pagesBook], goal('pages_read', 'b1')), 10, 'book pages goal: two devices = 10');
eq(goalSum(twoDevices, [pagesBook], goal('pages_read')), 10, 'any-book pages goal: two devices = 10');
eq(goalSum(twoDevices, [pagesBook], goal('chapters_read', 'b1')), 0.5, 'book chapters goal: 10 pages = 0.5 chapter');
eq(goalSum(chapLogs, [chapterBook], goal('chapters_read', 'c1')), 0.3, 'book chapters goal: two devices 1.0->1.3 = 0.3');
eq(goalSum(chapLogs, [chapterBook], goal('chapters_read')), 0.3, 'any-book chapters goal = 0.3');
eq(goalSum(chapLogs, [chapterBook], goal('pages_read', 'c1')), 6, 'book pages goal over chapter logs = 6 pages');
eq(goalSum([log({}), log({})], [pagesBook], goal('pages_read', 'b1')), 20, 'old logs: goal unchanged');

// 12. Same rule as points: on the shared fixtures without unit switches (plain sum), the counted
// pages of the award's logs give the award's points.
let checked = 0;
for (const s of fixtures.scenarios as unknown as { name: string; books: UserBook[]; logs: ReadingLog[]; points: number }[]) {
  const books = s.books;
  if (books.some((b) => Array.isArray(b.unitSwitches) && b.unitSwitches.length > 0)) continue;
  const ids = new Set(books.map((b) => b.id));
  const logs = s.logs.filter((l) => l.date === fixtures.day && l.finish !== true && l.bookId && ids.has(l.bookId));
  const counted = countedReadingAmounts(logs, books);
  const pages = logs.reduce((sum, l) => {
    const amount = counted.get(l) ?? 0;
    return sum + logPageAmount({ ...l, pagesRead: amount }, books.find((b) => b.id === l.bookId));
  }, 0);
  const start = new Date(`${fixtures.day}T00:00:00`).getTime();
  const award = computeReadingDayAward(s.logs, books, fixtures.day, start, start + 23 * 3600_000).entry?.amount ?? 0;
  eq(Math.min(Math.floor(pages / 2), 10), award, `${s.name}: counted pages match the award`);
  checked++;
}
assert(checked >= 10, `fixture parity ran on ${checked} scenarios`);

console.log('readingTotals: all assertions passed');
