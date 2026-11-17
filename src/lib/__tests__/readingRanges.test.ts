// Logs made from the same place on two devices count their pages once (Mode A "fix 10" follow-up,
// 2026-11-17; supabase/migrations/20261117173000_reading_awards_dedupe_ranges.sql). The shared
// fixtures (fixtures/readingRanges.json) are run here against the app's mirror and, by the PGlite
// check (work/rcl/pglite-test.mjs), against the SQL function, so both copies agree on the same cases.
// Mutation proof: each fixture's oldPoints is what the rule before this change gives (the logs with
// fromAmount removed), and the cases where it differs fail without the fix.
import type { ReadingLog, UserBook } from '@/types';
import fixtures from './fixtures/readingRanges.json';
import { addRange, computeReadingDayAward, logRange } from '../points/readingAwards';
import { readCycleOf, takeBackTodaysReading } from '../reading/bookUnits';
import { readingProgressPreview } from '../points/practicePreviews';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const DAY = fixtures.day;
const START = new Date(`${DAY}T00:00:00`).getTime();
const NOW = START + 23 * 3600_000;
type Scenario = { name: string; books: unknown[]; logs: unknown[]; points: number; oldPoints: number };
const points = (logs: ReadingLog[], books: UserBook[]) => computeReadingDayAward(logs, books, DAY, START, NOW).entry?.amount ?? 0;
const withoutRanges = (logs: ReadingLog[]) =>
  logs.map((l) => {
    const rest: ReadingLog = { ...l };
    delete rest.fromAmount;
    delete rest.readStartedAt;
    return rest;
  });

// 1. Shared fixtures: the new rule, and the old rule (no fromAmount) on the same logs.
let differs = 0;
for (const s of fixtures.scenarios as Scenario[]) {
  const logs = s.logs as ReadingLog[];
  const books = s.books as UserBook[];
  const got = points(logs, books);
  assert(got === s.points, `${s.name}: ${got} pts, expected ${s.points}`);
  const old = points(withoutRanges(logs), books);
  assert(old === s.oldPoints, `${s.name} (old rule): ${old} pts, expected ${s.oldPoints}`);
  if (s.points !== s.oldPoints) differs++;
}
assert(differs >= 5, 'the fixtures include cases the old rule counts twice');

// 2. Ranges: units, chapters in tenths, merging.
{
  const pagesBook = { unit: 'pages' } as UserBook;
  const chBook = { unit: 'chapters' } as UserBook;
  const base = { id: 'x', date: DAY, createdAt: '' };
  assert(logRange({ ...base, pagesRead: 6 }, pagesBook) === null, 'no fromAmount: no range');
  const r = logRange({ ...base, pagesRead: 0.2, unit: 'chapters', fromAmount: 1.1, readStartedAt: 's' }, pagesBook);
  assert(r !== null && r.key === 'chapters|s' && r.lo === 11 && r.hi === 13, 'chapter range in tenths, keyed by unit and read');
  const p = logRange({ ...base, pagesRead: 4, fromAmount: 20 }, chBook);
  assert(p !== null && p.key === 'chapters|' && p.lo === 200, 'a log without its own unit reads in the book unit');
  const a = addRange([], 20, 26);
  const b = addRange(a.ranges, 24, 30);
  assert(a.added === 6 && b.added === 4, 'partial overlap adds only the new part');
  const c = addRange(b.ranges, 40, 42);
  const d = addRange(c.ranges, 10, 50);
  assert(c.added === 2 && d.added === 40 - 10 - 2, 'a wide range adds only the gaps');
  assert(d.ranges.length === 1 && d.ranges[0][0] === 10 && d.ranges[0][1] === 50, 'covered ranges merge');
}

// 3. Adding a log never lowers the day (random days; the covered set only grows).
{
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  for (let n = 0; n < 400; n++) {
    const books = [
      { id: 'b1', unit: 'pages', status: 'reading', unitSwitches: rnd() < 0.3 ? [{ date: DAY, at: new Date(START + 5 * 3600_000).toISOString(), pagesBefore: 30, pagesAfter: pick([10, 20, 40]) }] : [] },
      { id: 'c1', unit: 'chapters', status: 'reading' },
    ] as unknown as UserBook[];
    const logs: ReadingLog[] = [];
    const count = 1 + Math.floor(rnd() * 6);
    for (let i = 0; i < count; i++) {
      const ch = rnd() < 0.3;
      logs.push({
        id: `l${i}`,
        bookId: ch ? 'c1' : 'b1',
        date: DAY,
        unit: ch ? 'chapters' : 'pages',
        pagesRead: ch ? pick([0.1, 0.2, 0.3, 1]) : pick([1, 2, 4, 6, 9]),
        ...(rnd() < 0.8 ? { fromAmount: ch ? pick([0, 1, 1.1, 1.2]) : pick([0, 10, 20, 24, 30]) } : {}),
        ...(rnd() < 0.2 ? { readStartedAt: pick(['r1', 'r2']) } : {}),
        createdAt: new Date(START + Math.floor(rnd() * 20) * 1800e3).toISOString(),
      });
    }
    const all = points(logs, books);
    for (let i = 0; i < logs.length; i++) {
      const fewer = points(logs.filter((_, j) => j !== i), books);
      assert(fewer <= all, `random day ${n}: removing log ${i} raised the day (${fewer} > ${all})`);
    }
    assert(all <= points(withoutRanges(logs), books), `random day ${n}: never more than the old rule`);
  }
}

// 4. The app writes what the server reads: a stale second device's preview, and a take-back.
{
  const book = { id: 'b1', unit: 'pages', status: 'reading', currentAmount: 20, totalAmount: 300, startedAt: 'S' } as unknown as UserBook;
  const fromA: ReadingLog = { id: 'a', bookId: 'b1', date: DAY, pagesRead: 10, unit: 'pages', fromAmount: 20, readStartedAt: 'S', createdAt: new Date(START + 3600_000).toISOString() };
  // Device B still shows page 20 and sets 30: no new pages, no new points.
  const stale = readingProgressPreview([fromA], [book], 'b1', 30, DAY, new Date(START + 2 * 3600_000).toISOString());
  assert(stale.before === 5 && stale.after === 5, `stale device 20 -> 30 adds nothing (${JSON.stringify(stale)})`);
  const real = readingProgressPreview([fromA], [{ ...book, currentAmount: 30 } as UserBook], 'b1', 40, DAY, new Date(START + 2 * 3600_000).toISOString());
  assert(real.after === 10, 'a real 30 -> 40 still earns');
  // Read again (new startedAt): the same pages count again.
  const reread = readingProgressPreview([fromA], [{ ...book, startedAt: 'S2' } as UserBook], 'b1', 30, DAY, new Date(START + 2 * 3600_000).toISOString());
  assert(reread.after === 10, 'a new read counts its pages again');
  assert(JSON.stringify(readCycleOf({ startedAt: 'S' })) === '{"readStartedAt":"S"}' && JSON.stringify(readCycleOf({})) === '{}', 'readCycleOf');

  // Lowering 30 -> 25 shrinks the log from the top: it still starts at 20 and covers 20 -> 25.
  const taken = takeBackTodaysReading([fromA], book, DAY, 5, new Date(START + 3 * 3600_000).toISOString(), () => 'refund');
  const shrunk = taken.logs.find((l) => l.id === 'a');
  assert(shrunk?.pagesRead === 5 && shrunk.fromAmount === 20 && shrunk.readStartedAt === 'S', 'a shrunk log keeps its start place');
  // A chapter log of a book now in pages, lowered by 1 page: it loses a tenth, and the 1-page
  // refund log has no fromAmount (counted in full, as before).
  const ch = { id: 'c1', unit: 'pages', status: 'reading', currentAmount: 26, totalAmount: 200 } as unknown as UserBook;
  const chLog: ReadingLog = { id: 'k', bookId: 'c1', date: DAY, pagesRead: 0.3, unit: 'chapters', fromAmount: 1, createdAt: new Date(START + 3600_000).toISOString() };
  const t2 = takeBackTodaysReading([chLog], ch, DAY, 1, new Date(START + 3 * 3600_000).toISOString(), () => 'refund');
  const refund = t2.logs.find((l) => l.id === 'refund');
  const kept = t2.logs.find((l) => l.id === 'k');
  assert(refund !== undefined && refund.fromAmount === undefined && refund.unit === 'pages', 'the refund log has no range');
  assert(kept?.fromAmount === 1 && kept.pagesRead === 0.2, 'the chapter log keeps its start and loses a tenth');
}

console.log('readingRanges: all assertions passed');
