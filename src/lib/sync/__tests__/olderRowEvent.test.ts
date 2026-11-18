// isOlderRowEvent (pull.ts): which live row events the realtime handler drops as late echoes.
// Opted in (dropsOlderEvents): reading_books, skills, tasks, time_tracker_templates, list_orders; a delete
// and a row without updatedAt are never dropped. Tables the server merges or rewrites stay out.
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

// Exactly these tables opt in; every other one keeps taking every live row (see syncedCollections.ts).
const optedIn = SYNCED_COLLECTIONS.filter((c) => c.dropsOlderEvents).map((c) => c.table).sort();
assert(
  JSON.stringify(optedIn) === JSON.stringify(['list_orders', 'reading_books', 'skills', 'tasks', 'time_tracker_templates']),
  `opted-in tables: ${optedIn.join(', ')}`
);
for (const table of ['habits', 'weekly_goals', 'time_tracker_days', 'bad_habit_logs', 'time_tracker_activities']) {
  assert(!SYNCED_COLLECTIONS.find((c) => c.table === table)?.dropsOlderEvents, `${table} does not opt in`);
}

// Document tables compare the item's own updatedAt (inside data).
for (const table of ['skills', 'list_orders', 'time_tracker_templates']) {
  const c = SYNCED_COLLECTIONS.find((x) => x.table === table) as SyncedCollection;
  assert(isOlderRowEvent(c, local, rowAt('2026-11-09T09:59:00.000Z')), `${table}: an older row is dropped`);
  assert(!isOlderRowEvent(c, local, rowAt('2026-11-09T10:00:00.000Z')), `${table}: the same time is taken`);
}

// Tasks: the row's updatedAt is its updated_at column (the server's keep-newer order).
const tasks = SYNCED_COLLECTIONS.find((c) => c.table === 'tasks') as SyncedCollection;
const taskRow = (updatedAt: string, extra: Record<string, unknown> = {}) => ({
  id: 't1', title: 'T', priority: 'medium', completed: false, subtasks: [], created_at: '2026-11-09T08:00:00+00:00', updated_at: updatedAt, ...extra,
});
const localTask = { id: 't1', title: 'T', updatedAt: '2026-11-09T10:00:00.000Z' };
assert(isOlderRowEvent(tasks, localTask, taskRow('2026-11-09T09:59:59.999+00:00')), 'tasks: an older row is dropped');
assert(!isOlderRowEvent(tasks, localTask, taskRow('2026-11-09T10:00:00.000456+00:00')), 'tasks: the same millisecond is taken');
assert(!isOlderRowEvent(tasks, localTask, taskRow('2026-11-09T10:00:01+00:00')), 'tasks: a newer row is taken');
assert(!isOlderRowEvent(tasks, localTask, taskRow('2026-11-09T09:00:00+00:00', { deleted_at: '2026-11-09T11:00:00+00:00' })), 'tasks: a delete is never dropped');
assert(!isOlderRowEvent(tasks, { id: 't1', title: 'T' }, taskRow('2026-11-09T09:00:00+00:00')), 'tasks: a local copy without updatedAt takes the row');
console.log('All isOlderRowEvent tests passed.');
