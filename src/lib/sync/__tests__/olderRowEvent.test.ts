// isOlderRowEvent (pull.ts): which live row events the realtime handler drops as late echoes.
// Only reading_books opts in (dropsOlderEvents); a delete and a row without updatedAt are never dropped.
import { isOlderRowEvent } from '../pull';
import { SYNCED_COLLECTIONS, type SyncedCollection } from '../syncedCollections';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const books = SYNCED_COLLECTIONS.find((c) => c.table === 'reading_books') as SyncedCollection;
const habits = SYNCED_COLLECTIONS.find((c) => c.table === 'habits') as SyncedCollection;
const local = { id: 'b1', title: 'T', updatedAt: '2026-11-09T10:00:00.000Z' };
const rowAt = (updatedAt?: string, extra: Record<string, unknown> = {}) => ({
  id: 'b1',
  data: { id: 'b1', title: 'T', ...(updatedAt ? { updatedAt } : {}) },
  ...extra,
});

assert(books.dropsOlderEvents === true, 'reading_books drops older events');
assert(isOlderRowEvent(books, local, rowAt('2026-11-09T09:59:59.000Z')), 'an older row is dropped');
assert(!isOlderRowEvent(books, local, rowAt('2026-11-09T10:00:00.000Z')), 'the same time is taken');
assert(!isOlderRowEvent(books, local, rowAt('2026-11-09T10:00:01.000Z')), 'a newer row is taken');
assert(!isOlderRowEvent(books, local, rowAt('2026-11-09T09:00:00.000Z', { deleted_at: '2026-11-09T11:00:00.000Z' })), 'a delete is never dropped');
assert(!isOlderRowEvent(books, local, rowAt(undefined)), 'a row without updatedAt is taken');
assert(!isOlderRowEvent(books, undefined, rowAt('2026-11-09T09:00:00.000Z')), 'a row the device lacks is taken');
// habits are merged on the server (habits_merge_row), so their events are never judged by time.
assert(!isOlderRowEvent(habits, local, rowAt('2026-11-09T09:00:00.000Z')), 'collections that do not opt in are untouched');
console.log('All isOlderRowEvent tests passed.');
