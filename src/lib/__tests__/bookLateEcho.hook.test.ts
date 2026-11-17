// Hook test (real useAppState + in-process fake Supabase, see harness/): a late realtime echo of an
// earlier book save must not undo a newer one. Found as the reading.hook T29 flake (2026-11-17):
// under load the echo of the details save arrived after the finish was already uploaded, and the
// realtime handler put the older row (reading, no takeaway) over the finished book.
//   T32  the details row's echo, delivered after finish and after restart, leaves the book as the
//        newer save made it; a newer row from another device is still taken.
import { bootHook, story, until, quiet, rows, eq, pass, server, UID } from './harness/bootHook';

const blobAt = 'Sun 2026-11-01 5:00 AM PKT (UTC+05:00)';

await story('bookLateEcho.hook (late realtime echo of a book save)', async () => {
  server.blob.set(UID, { state: { username: 'hooktester', lastSeenRelease: 100 }, updated_at: blobAt });
  const h = await bootHook({ as: 'signedIn' });
  await until(h.loaded, 'signed-in boot loaded');
  await quiet(1500);
  const book = () => h.s().state.libraryBooks.find((b) => b.title === 'EchoBook');
  type Row = { id: string; data?: { status?: string; reflection?: string; updatedAt?: string; title?: string } };
  const row = (id: string) => rows('reading_books').find((r: Row) => r.id === id) as Row | undefined;

  h.s().addCustomBookToLibrary('EchoBook', 'A', undefined, undefined, 50, 'pages', 'reading');
  await until(() => book(), 'T32: book in state');
  const id = book()!.id;
  h.s().updateBookDetails(id, { title: 'EchoBook', author: 'A', totalAmount: 60, unit: 'pages' });
  await until(() => row(id)?.data && (row(id)!.data as { totalAmount?: number }).totalAmount === 60, 'T32: details row saved', 5000);
  const detailsRow = structuredClone(row(id)!);

  h.s().finishBook(id, 'EchoTakeaway');
  await until(() => row(id)?.data?.status === 'completed', 'T32: finish row saved', 5000);
  await quiet(800);
  server.emit('reading_books', structuredClone(detailsRow), 'UPDATE');
  await quiet(800);
  eq([book()!.status, book()!.reflection], ['completed', 'EchoTakeaway'], 'T32: a late echo of the details save leaves the finished book');

  h.s().restartBook(id);
  await until(() => row(id)?.data?.status === 'reading' && row(id)?.data?.reflection === 'EchoTakeaway', 'T32: restart row saved', 5000);
  await quiet(800);
  server.emit('reading_books', structuredClone(detailsRow), 'UPDATE');
  await quiet(800);
  eq([book()!.status, book()!.currentAmount, book()!.reflection], ['reading', 0, 'EchoTakeaway'], 'T32: a late echo after restart keeps the takeaway');

  // A newer row (another device renamed the book) is still taken live.
  const newer = structuredClone(row(id)!);
  // eslint-disable-next-line no-restricted-syntax -- a stamp after every save above
  const later = new Date(Date.parse(String(newer.data!.updatedAt)) + 60_000).toISOString();
  newer.data = { ...newer.data, title: 'EchoBookRenamed', updatedAt: later };
  server.emit('reading_books', newer, 'UPDATE');
  await until(() => h.s().state.libraryBooks.some((b) => b.id === id && b.title === 'EchoBookRenamed'), 'T32: a newer row from another device is taken');
  pass('T32 a late realtime echo of an older book save never undoes finish or restart; newer rows still apply');
});
