// Hook test (real useAppState + in-process fake Supabase, see harness/): a new reading log carries
// the place it started from (fromAmount) and the book's read (readStartedAt) into reading_logs.data,
// so the server can count pages two devices logged from the same place once
// (20261117173000_reading_awards_dedupe_ranges.sql). Lowering keeps the start; "Read again" starts a
// new read.
import { bootHook, story, until, quiet, rows, eq, assert, pass } from './harness/bootHook';

await story('readingRanges.hook (log start place reaches the server)', async () => {
  const h = await bootHook({ as: 'signedIn' });
  await until(h.loaded, 'signed-in boot loaded');
  await quiet(1000);
  const today = (await import('../time/dates')).todayKey();
  const book = () => h.s().state.libraryBooks.find((b) => b.title === 'RangeBook');

  h.s().addCustomBookToLibrary('RangeBook', 'A', undefined, undefined, 100, 'pages', 'reading');
  await until(() => book(), 'book in state');
  const bookId = book()!.id;
  const started = book()!.startedAt;
  assert(typeof started === 'string' && started.length > 0, 'a new reading book has startedAt');
  const logs = () => h.s().state.readingLogs.filter((l) => l.bookId === bookId && l.date === today);

  h.s().updateReadingProgress(bookId, 20, 20);
  await until(() => logs().length === 1, 'first log');
  h.s().updateReadingProgress(bookId, 10, 30);
  await until(() => logs().length === 2, 'second log');
  const second = logs().find((l) => l.pagesRead === 10)!;
  eq([second.fromAmount, second.readStartedAt], [20, started], 'the 20 -> 30 log starts at 20 in this read');
  eq(logs().find((l) => l.pagesRead === 20)!.fromAmount, 0, 'the first log starts at 0');
  await until(
    () => rows('reading_logs').some((r: { id: string; data?: { fromAmount?: number; readStartedAt?: string } }) =>
      r.id === second.id && r.data?.fromAmount === 20 && r.data?.readStartedAt === started),
    'fromAmount and readStartedAt reached reading_logs.data',
    5000
  );

  h.s().updateReadingProgress(bookId, -5, 25);
  await until(() => logs().some((l) => l.id === second.id && l.pagesRead === 5), 'lowering to 25 shrinks the newest log');
  eq(logs().find((l) => l.id === second.id)!.fromAmount, 20, 'the shrunk log still starts at 20 (20 -> 25)');

  h.s().restartBook(bookId);
  await until(() => book()?.currentAmount === 0 && book()?.startedAt !== started, 'Read again: page 0, new startedAt');
  h.s().updateReadingProgress(bookId, 4, 4);
  await until(() => logs().length === 3, 're-read log');
  const reread = logs().find((l) => l.id !== second.id && l.pagesRead === 4)!;
  eq([reread.fromAmount, reread.readStartedAt], [0, book()!.startedAt], 'the re-read log starts at 0 in the new read');
  assert(reread.readStartedAt !== started, 'the re-read is a different read');

  pass('new logs carry fromAmount + readStartedAt to the server; lowering keeps the start; Read again starts a new read');
});
