// ownWrites.ts: which live events count as a late echo of this device's own earlier save on the
// column tables (judged by the server's stored updated_at), and that the records stay bounded and
// belong to one account only. Plus: exactly the seven column tables opt in.
import { MAX_OWN_WRITES, clearOwnWrites, isStaleOwnEcho, noteOwnWrites, ownWriteCount, timestampMicros } from '../ownWrites';
import { SYNCED_COLLECTIONS } from '../syncedCollections';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const U1 = 'user-1';
const U2 = 'user-2';
const B = '2026-11-18T09:00:00.500200+00:00';
const ev = (updated_at: string, extra: Record<string, unknown> = {}) => ({ id: 'g1', updated_at, ...extra });

// Timestamps: PostgREST and Realtime forms, microseconds kept.
assert(timestampMicros('2026-11-18T09:00:00.500200+00:00') === timestampMicros('2026-11-18 09:00:00.5002+00'), 'both text forms read alike');
assert(timestampMicros('2026-11-18T09:00:00.500100+00:00') < timestampMicros(B), 'microseconds inside one millisecond compare');
assert(timestampMicros('2026-11-18T09:00:00Z') === Date.parse('2026-11-18T09:00:00Z') * 1000, 'no fraction');
assert(Number.isNaN(timestampMicros('not a time')) && Number.isNaN(timestampMicros(undefined)), 'unreadable is NaN');

noteOwnWrites(U1, 'goals', [{ id: 'g1', updated_at: B }]);
assert(isStaleOwnEcho(U1, 'goals', ev('2026-11-18T09:00:00.100+00:00')), 'an older event is a late echo');
assert(isStaleOwnEcho(U1, 'goals', ev('2026-11-18T09:00:00.500100+00:00')), 'older by microseconds is a late echo');
assert(!isStaleOwnEcho(U1, 'goals', ev(B)), 'the echo of the stored write itself is taken');
assert(!isStaleOwnEcho(U1, 'goals', ev('2026-11-18T09:00:01+00:00')), 'a newer row (another device) is taken');
assert(!isStaleOwnEcho(U1, 'goals', ev('2026-11-18T09:00:00.100+00:00', { deleted_at: '2026-11-18T09:00:00.100+00:00' })), 'a delete is never dropped');
assert(!isStaleOwnEcho(U1, 'goals', { id: 'g2', updated_at: '2020-01-01T00:00:00Z' }), 'a row this device never wrote is taken');
assert(!isStaleOwnEcho(U1, 'projects', ev('2026-11-18T09:00:00.100+00:00')), 'records are per table');
assert(!isStaleOwnEcho(U1, 'goals', ev('garbage')), 'an unreadable time is taken');

// A record never goes back (an older stored copy noted later does not lower it).
noteOwnWrites(U1, 'goals', [{ id: 'g1', updated_at: '2026-11-18T08:00:00Z' }]);
assert(isStaleOwnEcho(U1, 'goals', ev('2026-11-18T09:00:00.100+00:00')), 'record keeps the newest stored time');
// Rows refused by the server (absent from the reply) and junk are not recorded.
noteOwnWrites(U1, 'goals', null);
noteOwnWrites(U1, 'goals', [{ id: 'g3' }, null, { updated_at: B }]);
assert(ownWriteCount() === 1, 'only readable rows are recorded');

// Another account: nothing recorded for the first one applies, and its records are gone.
assert(!isStaleOwnEcho(U2, 'goals', ev('2026-11-18T09:00:00.100+00:00')), 'another account is never judged by these records');
noteOwnWrites(U2, 'goals', [{ id: 'x', updated_at: B }]);
assert(ownWriteCount() === 1 && !isStaleOwnEcho(U1, 'goals', ev('2026-11-18T09:00:00.100+00:00')), 'switching account forgets the old records');
clearOwnWrites();
assert(ownWriteCount() === 0 && !isStaleOwnEcho(U2, 'goals', { id: 'x', updated_at: '2020-01-01T00:00:00Z' }), 'clearOwnWrites forgets everything');

// Bounded: the oldest records go first.
for (let i = 0; i < MAX_OWN_WRITES + 50; i++) noteOwnWrites(U1, 'goals', [{ id: `r${i}`, updated_at: B }]);
assert(ownWriteCount() === MAX_OWN_WRITES, 'records stay bounded');
assert(!isStaleOwnEcho(U1, 'goals', { id: 'r0', updated_at: '2020-01-01T00:00:00Z' }), 'the oldest record was forgotten');
assert(isStaleOwnEcho(U1, 'goals', { id: `r${MAX_OWN_WRITES + 49}`, updated_at: '2020-01-01T00:00:00Z' }), 'the newest record is kept');
clearOwnWrites();

// Exactly the seven column tables opt in (keep-newer, no server merge or rewrite, no item updatedAt).
const optedIn = SYNCED_COLLECTIONS.filter((c) => c.dropsOwnStaleEchoes).map((c) => c.table).sort();
const expected = ['craving_logs', 'decision_logs', 'emotion_logs', 'focus_logs', 'goals', 'journal_entries', 'projects'];
assert(JSON.stringify(optedIn) === JSON.stringify(expected), `opted-in tables: ${optedIn.join(', ')}`);

console.log('ownWrites: all assertions passed');
