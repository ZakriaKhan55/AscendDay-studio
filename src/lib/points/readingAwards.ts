import type { BookUnitSwitch, PointsEntry, ReadingLog, UserBook } from '@/types';
import { READING_POINTS } from './pointsConfig';
import { addDays as addDayKeys, localDayOf, timeMsOr } from '../time/dates';
import { awardGainedAt, gainedAtField } from './awardGainedAt';

/**
 * Reading points are written by the server (supabase/migrations/20261015160000_server_reading_awards.sql):
 * one row per local day for the day's pages (up to the daily cap) and one finish bonus per book.
 * The app computes the same rows only to show them before the server's copies arrive; it never
 * uploads them, and the server skips any app write to them. Change both sides together.
 * The server stores a log only when it is dated today, or when it is a new log dated yesterday
 * that first arrives today (made offline before midnight): that one raises yesterday's award, never
 * lowers it, within the daily cap (readingLateDay, computeReadingDayAward floor;
 * 20261105160000_reading_skill_late_day_logs.sql). Older days never move, and a log already on the
 * server can only be edited on its own day.
 */

/** First local day whose reading points come from the server; older app-written rows stay. */
export const READING_AWARDS_SERVER_SINCE = '2026-10-15';

/** Finish bonus gates: distinct days with logged pages, and days since the first logged page. */
export const READING_BONUS_MIN_LOG_DAYS = 5;
export const READING_BONUS_MIN_SPAN_DAYS = 7;
/** Finish bonuses are at least this many local days apart (one per book still, decided on the finishing day). */
export const READING_BONUS_COOLDOWN_DAYS = 13;

export const readingAwardId = (day: string) => `reading_award_${day}`;
export const readingBonusId = (bookId: string) => `reading_bonus_${bookId}`;

/** Point entry ids only the server writes: daily page awards and finish bonuses. */
export const isServerOwnedReadingPointId = (id: string): boolean =>
  id.startsWith('reading_award_') || id.startsWith('reading_bonus_');

/** A page award the app wrote itself ("Read N pages of …"), on the local day it was logged. */
const appWrittenAwardDay = (entry: PointsEntry): string | null =>
  !isServerOwnedReadingPointId(entry.id || '') && entry.source === 'reading' && entry.amount > 0
    ? localDayOf(entry.timestamp)
    : null;

/** The day's page award row: the server's own, or one the app wrote for a day the server owns. */
export const isReadingDayEntry = (entry: PointsEntry, day: string): boolean =>
  entry.id === readingAwardId(day) || (day >= READING_AWARDS_SERVER_SINCE && appWrittenAwardDay(entry) === day);

/** An app-written page award or finish bonus for a day the server owns: the server retired them. */
export const isRetiredAppReadingAward = (entry: PointsEntry): boolean => {
  if (isServerOwnedReadingPointId(entry.id || '')) return false;
  const day =
    entry.source === 'reading_bonus' && entry.amount > 0 ? localDayOf(entry.timestamp) : appWrittenAwardDay(entry);
  return day !== null && day >= READING_AWARDS_SERVER_SINCE;
};

const timeOf = (value: string): number => timeMsOr(value, Infinity);

/** Mirror of ascend_reading_log_pages: only a positive numeric page count counts. */
const logPages = (log: ReadingLog): number =>
  typeof log.pagesRead === 'number' && Number.isFinite(log.pagesRead) ? Math.max(0, log.pagesRead) : 0;

/** The book counts in chapters (unit "chapters" in any case; anything else is pages), as the server reads it. */
export const isChapterBook = (book: Pick<UserBook, 'unit'>): boolean => String(book.unit || '').toLowerCase() === 'chapters';

/** Pages one chapter counts as for points: 1 chapter = pointsPerChapter points. */
export const PAGES_PER_CHAPTER = READING_POINTS.pointsPerChapter * READING_POINTS.pagesPerPoint;

const validUnit = (unit: unknown): 'pages' | 'chapters' | null => {
  const u = typeof unit === 'string' ? unit.toLowerCase() : '';
  return u === 'pages' || u === 'chapters' ? u : null;
};

/**
 * The unit a log was written in: its own `unit` (stamped by the reading_logs_unit trigger, and by
 * the app on new logs), else the book's current unit (a log made before units were stamped).
 * A book can switch units (switchBookUnit), so a log is never read in the book's unit when it has its own.
 */
export const logUnit = (log: Pick<ReadingLog, 'unit'>, book: Pick<UserBook, 'unit'> | undefined): 'pages' | 'chapters' =>
  validUnit(log.unit) ?? (book && isChapterBook(book) ? 'chapters' : 'pages');

/** Pages a tenth of a chapter counts as (2): chapters are logged in steps of 0.1. */
export const PAGES_PER_CHAPTER_TENTH = PAGES_PER_CHAPTER / 10;

/**
 * A chapter amount in whole tenths (1.3 -> 13). Chapters are logged in steps of 0.1 and every amount
 * is snapped here, so float noise (1.3 - 1.1 = 0.19999999999999996) never loses a point. Mirror of
 * the server's round(chapters * 10) (20261112200000_reading_chapter_tenths.sql); both round a half
 * up for the positive amounts that count.
 */
export const chapterTenths = (chapters: number): number => Math.round(chapters * 10);

/** An amount in its unit, snapped: chapters to the nearest tenth, pages as they are. */
export const snapReadingAmount = (n: number, unit: 'pages' | 'chapters'): number =>
  unit === 'chapters' ? chapterTenths(n) / 10 : n;

/** An amount in pages: chapters snapped to tenths, each tenth PAGES_PER_CHAPTER_TENTH pages (always whole); pages as they are. */
export const readingAmountPages = (n: number, unit: 'pages' | 'chapters'): number =>
  unit === 'chapters' ? chapterTenths(n) * PAGES_PER_CHAPTER_TENTH : n;

/** A log's amount in pages (readingAmountPages in the log's unit); only a positive number counts. */
export const logPageAmount = (log: ReadingLog, book: Pick<UserBook, 'unit'> | undefined): number =>
  readingAmountPages(logPages(log), logUnit(log, book));

/**
 * The place range a log covers, for the de-duplication of logs made from the same place on two
 * devices (20261117173000_reading_awards_dedupe_ranges.sql): [lo, hi) in the log's unit, chapters
 * in whole tenths, and the key its ranges are compared under (unit + the book's read it was made
 * in, readStartedAt). null for a log without a usable fromAmount (older logs and older app
 * versions): it adds its whole amount, as before.
 */
export function logRange(log: ReadingLog, book: Pick<UserBook, 'unit'> | undefined): { key: string; lo: number; hi: number } | null {
  const from = log.fromAmount;
  if (typeof from !== 'number' || !Number.isFinite(from) || from < 0) return null;
  const unit = logUnit(log, book);
  const amount = logPages(log);
  const lo = unit === 'chapters' ? chapterTenths(from) : from;
  const hi = lo + (unit === 'chapters' ? chapterTenths(amount) : amount);
  return { key: `${unit}|${typeof log.readStartedAt === 'string' ? log.readStartedAt : ''}`, lo, hi };
}

/**
 * Adds [lo, hi) to `ranges` (disjoint) and returns how much of it was not covered yet: the
 * covered set only grows, so a later log never adds what an earlier one already counted.
 */
export function addRange(ranges: [number, number][], lo: number, hi: number): { added: number; ranges: [number, number][] } {
  let added = hi - lo;
  let mlo = lo;
  let mhi = hi;
  const keep: [number, number][] = [];
  for (const [rlo, rhi] of ranges) {
    added -= Math.max(0, Math.min(hi, rhi) - Math.max(lo, rlo));
    if (rhi < lo || rlo > hi) keep.push([rlo, rhi]);
    else {
      mlo = Math.min(mlo, rlo);
      mhi = Math.max(mhi, rhi);
    }
  }
  return { added: Math.max(0, added), ranges: [...keep, [mlo, mhi]] };
}

/**
 * How far a unit switch moved the book's place, in pages (after minus before): below 0 when it
 * lowered the place, above 0 when it raised it, 0 for an entry that can't be read.
 */
export const unitSwitchChange = (s: BookUnitSwitch): number =>
  typeof s?.pagesBefore === 'number' && typeof s?.pagesAfter === 'number' && Number.isFinite(s.pagesBefore) && Number.isFinite(s.pagesAfter)
    ? s.pagesAfter - s.pagesBefore
    : 0;

/**
 * The day before `today` when the server raises it for this log (reading_award_points): a live log
 * dated yesterday, which the server only stores as a new log arriving today
 * (reading_logs_guard_today). null otherwise: today's logs earn on today, older ones never earn.
 */
export function readingLateDay(log: Pick<ReadingLog, 'date'> | null | undefined, today: string): string | null {
  const yesterday = addDayKeys(today, -1);
  return log && log.date === yesterday ? yesterday : null;
}

/**
 * A Finish log (the unread pages Finish adds): no page points and covers nothing. Same test as the
 * server's `(data->>'finish') = 'true'`, so a string "true" counts too (the app writes a boolean).
 */
const isFinishLog = (log: Pick<ReadingLog, 'finish'>): boolean => (log.finish as unknown) === true || (log.finish as unknown) === 'true';

/** One event of a reading day: a log's pages, or a unit switch's change of the book's place (unitSwitchChange). */
type ReadingDayEvent = { at: number; kind: 0 | 1; key: string; bookId: string; pages: number; log?: ReadingLog };

/**
 * The day's logs (as given) and the unit switches of that day of the books in `bookById`, in the
 * server's order: time (unknown last), logs before switches, then id byte order.
 */
function readingDayEvents(dayLogs: ReadingLog[], bookById: Map<string, UserBook>, day: string): ReadingDayEvent[] {
  const events: ReadingDayEvent[] = dayLogs.map((l) => ({
    at: timeOf(l.createdAt),
    kind: 0,
    key: l.id,
    bookId: String(l.bookId ?? ''),
    pages: logPageAmount(l, bookById.get(l.bookId ?? '')),
    log: l,
  }));
  for (const b of bookById.values()) {
    (Array.isArray(b.unitSwitches) ? b.unitSwitches : []).forEach((s, i) => {
      if (s && s.date === day && typeof s.pagesBefore === 'number' && typeof s.pagesAfter === 'number') {
        events.push({ at: timeOf(s.at), kind: 1, key: `${b.id}#${i + 1}`, bookId: b.id, pages: unitSwitchChange(s) });
      }
    });
  }
  events.sort((a, b) => a.at - b.at || a.kind - b.kind || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return events;
}

/**
 * The covered-range rule of one day, shared by the page award and the shown totals: for each event
 * (same index), the pages it counts. A log with a start place (logRange) counts only the part of
 * its range that earlier logs of that book, unit and read did not already cover that day; a unit
 * switch starts the book's covered ranges over (and counts its own change, which the award's
 * owed/best rule then handles). A log without fromAmount, and a Finish log, counts its whole amount
 * and covers nothing. Server: the one SQL copy is ascend_reading_log_counted, which the page award
 * also reads (20261118131000_reading_awards_use_counted_helper.sql).
 */
function coverReadingDayEvents(events: ReadingDayEvent[], bookById: Map<string, UserBook>): number[] {
  const covered = new Map<string, Map<string, [number, number][]>>();
  return events.map((ev) => {
    if (!ev.log) {
      covered.delete(ev.bookId);
      return ev.pages;
    }
    const range = isFinishLog(ev.log) ? null : logRange(ev.log, bookById.get(ev.bookId));
    if (!range) return ev.pages;
    const byKey = covered.get(ev.bookId) ?? new Map<string, [number, number][]>();
    const { added, ranges } = addRange(byKey.get(range.key) ?? [], range.lo, range.hi);
    byKey.set(range.key, ranges);
    covered.set(ev.bookId, byKey);
    return range.key.startsWith('chapters|') ? added * PAGES_PER_CHAPTER_TENTH : added;
  });
}

/**
 * What each log counts in totals shown to the user (the Reading chart, linked weekly goals), in
 * the log's own unit (logUnit): pages, or chapters to a tenth. Uses the page award's covered-range
 * rule (coverReadingDayEvents) per day, so two devices logging 20 -> 30 from the same place show
 * 10 pages, not 20; a log without fromAmount (older logs, app 1.4.1) and a Finish log count in
 * full, as before. Unlike the award, logs of books no longer in the library are kept (they count
 * among themselves). Keyed by the log object. Server mirror for the member card:
 * ascend_reading_log_counted (20261118110000_member_card_reading_dedupe.sql).
 */
export function countedReadingAmounts(logs: ReadingLog[], books: UserBook[]): Map<ReadingLog, number> {
  const bookById = new Map(books.filter(Boolean).map((b) => [b.id, b]));
  const byDay = new Map<string, ReadingLog[]>();
  for (const l of logs) {
    if (!l || typeof l.date !== 'string') continue;
    const list = byDay.get(l.date);
    if (list) list.push(l);
    else byDay.set(l.date, [l]);
  }
  const out = new Map<ReadingLog, number>();
  for (const [day, dayLogs] of byDay) {
    const events = readingDayEvents(dayLogs, bookById, day);
    const counted = coverReadingDayEvents(events, bookById);
    events.forEach((ev, i) => {
      if (!ev.log) return;
      const pages = counted[i];
      out.set(
        ev.log,
        logUnit(ev.log, bookById.get(ev.bookId)) === 'chapters' ? Math.round(pages / PAGES_PER_CHAPTER_TENTH) / 10 : pages
      );
    });
  }
  return out;
}

/** Last millisecond of a local day (a new award row is never stamped after it). */
const dayLastMs = (day: string): number => new Date(`${addDayKeys(day, 1)}T00:00:00`).getTime() - 1;

/**
 * Mirror of ascend_recompute_reading_awards: the page award entry of one local day (null when the
 * day earns nothing), and each counted log's share in log order (shown on the log). Only logs of
 * books still in the library count, and not the pages Finish adds (finish: true); a log in chapters
 * counts each tenth of a chapter as PAGES_PER_CHAPTER_TENTH pages (the log's own unit, logUnit).
 * Per book, in time order, each log adds its pages; a unit switch of that day that lowered the
 * book's place subtracts the pages it took off (and owes them), one that raised it gives back at most
 * what earlier switches that day still owe (unitSwitchChange). The book earns for the highest running
 * total it reached (never below 0). So a switch never earns or takes points, reading the same pages
 * again after a lowering switch earns nothing until the book passes where it was, and switching back
 * to the old place makes new reading earn again. A day without a switch is the plain sum.
 * A log with a start place (fromAmount, logRange) adds only the part of its range that earlier
 * logs of that book, unit and read did not already cover that day (so two devices logging 20 -> 30
 * from the same place count 10 pages once); a unit switch starts the book's covered ranges over
 * (the switch rule above governs reading pages again after it). A log without fromAmount adds its
 * whole amount.
 * Points = floor(the books' pages / pagesPerPoint), capped across all books.
 * The row's time follows the server: a day whose row already exists (existing, the live ledger row)
 * keeps that row's time and only the amount changes; a new row is stamped at the day's first
 * earning log, clamped to [dayStartMs, nowMs] and never after the day's last millisecond.
 * `floor` (yesterday, for a late log): the amount can only go up, and an existing row is kept as it
 * is when the recomputed amount is not above it.
 * A rise over the existing row stamps gainedAt (awardGainedAt).
 */
export function computeReadingDayAward(
  logs: ReadingLog[],
  books: UserBook[],
  day: string,
  dayStartMs: number,
  nowMs: number,
  existing?: PointsEntry | null,
  opts: { floor?: boolean } = {}
): { entry: PointsEntry | null; logPoints: Map<string, number> } {
  const bookById = new Map(books.filter(Boolean).map((b) => [b.id, b]));
  const dayLogs = logs.filter((l) => l && l.date === day && !isFinishLog(l) && Boolean(l.bookId && bookById.has(l.bookId)));
  const events = readingDayEvents(dayLogs, bookById, day);
  const counted = coverReadingDayEvents(events, bookById);

  const logPoints = new Map<string, number>();
  const running = new Map<string, { total: number; best: number; owed: number }>();
  let pages = 0;
  let used = 0;
  let firstMs: number | null = null;
  for (const [i, ev] of events.entries()) {
    const book = running.get(ev.bookId) ?? { total: 0, best: 0, owed: 0 };
    const evPages = counted[i];
    if (ev.log || ev.pages < 0) book.total += evPages;
    else book.total += Math.min(ev.pages, book.owed);
    if (!ev.log) book.owed = Math.max(0, book.owed - ev.pages);
    const best = Math.max(book.best, book.total);
    pages += best - book.best;
    book.best = best;
    running.set(ev.bookId, book);
    if (!ev.log) continue;
    const earned = Math.min(Math.floor(pages / READING_POINTS.pagesPerPoint), READING_POINTS.dailyCap);
    logPoints.set(ev.log.id, earned - used);
    used = earned;
    if (firstMs === null && used > 0) firstMs = ev.at;
  }
  // The award is the whole day's pages, as the server's v_used after its loop: a unit switch after
  // the day's last log that gives back owed pages counts too (no log's points carry it).
  used = Math.min(Math.floor(pages / READING_POINTS.pagesPerPoint), READING_POINTS.dailyCap);
  const id = readingAwardId(day);
  const kept = existing && existing.id === id ? existing : null;
  if (opts.floor && used <= (kept?.amount ?? 0)) return { entry: kept, logPoints };
  if (used <= 0) return { entry: null, logPoints };

  // No log earned the first point (only a later switch did): the server's v_first stays NULL and
  // greatest() ignores it, so the award's time is the day's start. A log with no time counts as now.
  const firstAt = firstMs === null ? dayStartMs : Number.isFinite(firstMs) ? firstMs : nowMs;
  const at = Math.min(Math.max(firstAt, dayStartMs), nowMs, dayLastMs(day));
  return {
    entry: {
      id,
      amount: used,
      reason: `Pages logged (${dayLogs.length})`,
      source: 'reading',
      timestamp: existing && existing.id === id ? existing.timestamp : new Date(at).toISOString(),
      metadata: { date: day, logs: dayLogs.length },
      ...gainedAtField(awardGainedAt(kept, used, nowMs)),
    },
    logPoints,
  };
}

/** Whole days from one day key to a later one. */
const daysBetween = (from: string, to: string): number => {
  const [fY, fM, fD] = from.split('-').map(Number);
  const [tY, tM, tD] = to.split('-').map(Number);
  return Math.round((Date.UTC(tY, tM - 1, tD) - Date.UTC(fY, fM - 1, fD)) / 86400000);
};

/**
 * The finish bonus gates of one book, as ascend_recompute_reading_bonus counts them: distinct days
 * with logged pages (loggedDays, at least READING_BONUS_MIN_LOG_DAYS) and days from the first of
 * them to today (spanDays, at least READING_BONUS_MIN_SPAN_DAYS). finishAddsToday counts today as
 * a reading day for a Finish that will add the unread pages (its log is not written yet).
 */
export function readingBonusProgress(
  bookId: string,
  logs: ReadingLog[],
  today: string,
  finishAddsToday = false
): { loggedDays: number; spanDays: number; meetsDays: boolean; meetsSpan: boolean } {
  const days = new Set(logs.filter((l) => l && l.bookId === bookId && logPages(l) > 0).map((l) => l.date));
  if (finishAddsToday) days.add(today);
  const first = [...days].sort()[0];
  const spanDays = first ? daysBetween(first, today) : 0;
  return {
    loggedDays: days.size,
    spanDays,
    meetsDays: days.size >= READING_BONUS_MIN_LOG_DAYS,
    meetsSpan: spanDays >= READING_BONUS_MIN_SPAN_DAYS,
  };
}

const addDays = (day: string, days: number): string => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/**
 * Mirror of ascend_recompute_reading_bonus's cooldown: the latest live finish bonus of another book
 * (lastDay) and the first day the next one can be given (nextDay = lastDay + 13). active while
 * today is before nextDay; a book finished then never gets its bonus.
 */
export function readingBonusCooldown(
  bookId: string,
  pointsHistory: PointsEntry[],
  today: string
): { active: boolean; lastDay: string | null; nextDay: string | null } {
  let lastDay: string | null = null;
  for (const e of pointsHistory) {
    if (!e || e.id === readingBonusId(bookId) || !(e.id || '').startsWith('reading_bonus_') || !(e.amount > 0)) continue;
    const day = localDayOf(e.timestamp);
    if (day && (!lastDay || day > lastDay)) lastDay = day;
  }
  const nextDay = lastDay ? addDays(lastDay, READING_BONUS_COOLDOWN_DAYS) : null;
  return { active: Boolean(nextDay && today < nextDay), lastDay, nextDay };
}

/** The book already holds its finish bonus: a server row with its id, or one the app gave before. */
export const readingBonusAlreadyGiven = (book: UserBook, pointsHistory: PointsEntry[]): boolean =>
  (book.pointsAwarded ?? 0) > 0 || pointsHistory.some((e) => e && e.id === readingBonusId(book.id));

/**
 * Mirror of ascend_recompute_reading_bonus's gates: the book is completed and readingBonusProgress
 * meets both gates. Whether a bonus was already given is the caller's check (readingBonusAlreadyGiven).
 */
export function meetsReadingBonusGates(book: UserBook, logs: ReadingLog[], today: string): boolean {
  if (book.status !== 'completed') return false;
  const { meetsDays, meetsSpan } = readingBonusProgress(book.id, logs, today);
  return meetsDays && meetsSpan;
}

/**
 * Points removing a library book takes back, as deleteBook and the server do
 * (ascend_recompute_reading_bonus + ascend_recompute_reading_awards for today):
 * - bonus: its live finish bonus row (reading_bonus_<id>), or, with no live row, the bonus the app
 *   gave before server bonuses (book.pointsAwarded), which the server takes back as a minus row
 *   (its deleted legacy marker's legacyAmount, the same number for every such book).
 * - today: today's page award now minus today's award without this book's logs (the daily cap is
 *   shared, so this can be less than the book's own pages). Earlier days' page points stay.
 */
export function bookRemovalPoints(
  book: UserBook,
  libraryBooks: UserBook[],
  readingLogs: ReadingLog[],
  pointsHistory: PointsEntry[],
  today: string
): { bonus: number; today: number; total: number } {
  const ids = new Set<string>([book.id, book.linkedBookId].filter((id): id is string => Boolean(id)));

  let bonus = 0;
  for (const id of ids) {
    const row = pointsHistory.find((e) => e && e.id === readingBonusId(id));
    if (row) {
      bonus += Math.max(0, Number(row.amount) || 0);
      continue;
    }
    const lb = libraryBooks.find((b) => b && b.id === id);
    bonus += Math.max(0, lb?.pointsAwarded ?? 0);
  }

  const todayNow = pointsHistory
    .filter((e) => e && isReadingDayEntry(e, today))
    .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  const remainingLogs = readingLogs.filter((l) => l && !(l.bookId && ids.has(l.bookId)));
  const remainingBooks = libraryBooks.filter((b) => b && !ids.has(b.id));
  const dayStartMs = new Date(`${today}T00:00:00`).getTime();
  const todayAfter = computeReadingDayAward(remainingLogs, remainingBooks, today, dayStartMs, dayStartMs).entry?.amount ?? 0;
  const todayLoss = Math.max(0, todayNow - todayAfter);

  return { bonus, today: todayLoss, total: bonus + todayLoss };
}
