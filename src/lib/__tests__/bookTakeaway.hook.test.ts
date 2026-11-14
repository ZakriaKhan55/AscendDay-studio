// Hook test (real useAppState + in-process fake Supabase, see harness/): a finished book's key
// takeaway can be emptied in Edit book (CodeRabbit CR-04-16, 2026-11-14). Before, an empty field
// fell back to the old takeaway, so it could never be removed.
//   T31  editing a finished book with a new takeaway saves it; with an empty one removes it (state
//        and reading_books row); an edit that leaves the takeaway out keeps it.
import { bootHook, story, until, quiet, rows, eq, pass, server, UID } from './harness/bootHook';

const blobAt = 'Sun 2026-11-01 5:00 AM PKT (UTC+05:00)';

await story('bookTakeaway.hook (clear a finished book takeaway)', async () => {
  server.blob.set(UID, { state: { username: 'hooktester', lastSeenRelease: 100 }, updated_at: blobAt });
  const h = await bootHook({ as: 'signedIn' });
  await until(h.loaded, 'signed-in boot loaded');
  await quiet(1500);
  const book = () => h.s().state.libraryBooks.find((b) => b.title === 'TakeawayBook');
  const row = (id: string) => rows('reading_books').find((r: { id: string }) => r.id === id) as { data?: { reflection?: string } } | undefined;
  const details = (reflection?: string) => ({ title: 'TakeawayBook', author: 'A', totalAmount: 50, unit: 'pages' as const, ...(reflection === undefined ? {} : { reflection }) });

  h.s().addCustomBookToLibrary('TakeawayBook', 'A', undefined, undefined, 50, 'pages', 'reading');
  await until(() => book(), 'T31: book in state');
  const id = book()!.id;
  h.s().finishBook(id, 'First takeaway');
  await until(() => book()!.status === 'completed' && book()!.reflection === 'First takeaway', 'T31: finished with a takeaway');
  await until(() => row(id)?.data?.reflection === 'First takeaway', 'T31: takeaway reached reading_books', 5000);

  h.s().updateBookDetails(id, details('  Second takeaway  '));
  await until(() => book()!.reflection === 'Second takeaway', 'T31: a new takeaway is saved (trimmed)');

  h.s().updateBookDetails(id, details('   '));
  await until(() => book()!.reflection === undefined, 'T31: an emptied takeaway is removed');
  await until(() => row(id) !== undefined && row(id)!.data?.reflection === undefined, 'T31: removal reached reading_books', 5000);

  h.s().updateBookDetails(id, details('Third'));
  await until(() => book()!.reflection === 'Third', 'T31: takeaway written again');
  h.s().updateBookDetails(id, details());
  await quiet(600);
  eq(book()!.reflection, 'Third', 'T31: an edit that leaves the takeaway out keeps it');
  pass('T31 a finished book takeaway is saved, emptied (state and row), and kept when left out');
});
