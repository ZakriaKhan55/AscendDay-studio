// goals.manual_mode / projects.manual_mode (1.6.0) in the synced collections: toRow always sends
// the column (fixed key set, so a batched upsert never turns it NULL), fromRow sets manualMode only
// when true, and the default false is left out of the row hash, so rows hashed by 1.5.x devices
// (baselines in localStorage) still match unchanged items after the update.
import type { Goal, Project } from '../../types';
const { SYNCED_COLLECTIONS } = await import('../sync/syncedCollections');
const { hashRow } = await import('../sync/rowHash');

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const created = '2026-11-01T00:00:00.000Z'; // isoTime form, so fromRow gives it back as is
const goals = SYNCED_COLLECTIONS.find((c) => c.table === 'goals')!;
const projects = SYNCED_COLLECTIONS.find((c) => c.table === 'projects')!;

for (const [name, collection, item] of [
  ['goals', goals, { id: 'g1', title: 'G', status: 'active', manualProgress: 0, sequentialMode: true, createdAt: created } as Goal],
  ['projects', projects, { id: 'p1', title: 'P', status: 'in_progress', manualProgress: 20, order: 0, createdAt: created } as Project],
] as const) {
  const off = collection.toRow(item as never);
  const on = collection.toRow({ ...item, manualMode: true } as never);
  const offExplicit = collection.toRow({ ...item, manualMode: false } as never);
  assert(off.manual_mode === false && offExplicit.manual_mode === false && on.manual_mode === true, `${name}: toRow sends manual_mode false/true`);
  assert(Object.keys(off).join() === Object.keys(on).join(), `${name}: same key set either way`);

  const withoutKey = { ...off, user_id: 'u' } as Record<string, unknown>;
  delete withoutKey.manual_mode;
  assert(!('manualMode' in (collection.fromRow(withoutKey) as object)), `${name}: row without the column → no manualMode`);
  assert(!('manualMode' in (collection.fromRow({ ...off }) as object)), `${name}: manual_mode false → no manualMode`);
  assert((collection.fromRow({ ...on }) as { manualMode?: boolean }).manualMode === true, `${name}: manual_mode true → manualMode true`);
  assert(hashRow(collection.toRow(collection.fromRow({ ...on }) as never)) === hashRow(on), `${name}: round trip hashes like the item (on)`);
  assert(hashRow(collection.toRow(collection.fromRow({ ...off }) as never)) === hashRow(off), `${name}: round trip hashes like the item (off)`);

  // The 1.5.x row had no manual_mode key: an unchanged item must hash the same, a manual one not.
  const legacy = { ...off } as Record<string, unknown>;
  delete legacy.manual_mode;
  assert(hashRow(off) === hashRow(legacy) && hashRow(offExplicit) === hashRow(legacy), `${name}: default false hashes like the 1.5.x row`);
  assert(hashRow(on) !== hashRow(legacy), `${name}: manual_mode true changes the hash (the switch uploads)`);
}

// Other columns are untouched by the omission: a false value elsewhere still counts.
assert(hashRow({ a: 1, completed: false }) !== hashRow({ a: 1 }), 'only manual_mode default is left out');
assert(hashRow({ a: 1, manual_mode: null }) !== hashRow({ a: 1 }), 'manual_mode null is not the default');

console.log('manualModeSync: all assertions passed');
