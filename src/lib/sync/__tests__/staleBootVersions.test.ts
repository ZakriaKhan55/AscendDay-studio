// A cold boot from a device cache whose stored tab versions lag one save behind the shared baseline
// (they were stored with the cache before the save's diff moved them, and the tab closed before the
// next state change stored them again). The cached copy equals the baseline, so it reached the
// server: it is not an unsent edit. The server's newer row (another device's edit) must replace it
// and nothing may be uploaded; a real unsent edit must still be kept and upload with its edit time.
// Covers a jsonb document table (habits: rename + tick), relational tables (tasks, goals, also a
// goal set by hand, since rowHash leaves manual_mode false out) and time tracker days (merge branch).
// Also covers storeTabSyncedHashesOver (F2): it stores only over this tab's own stored versions.
// Incident: knowledge/mode-a-stale-copy-rollback-2026-11-22.md.
import { DEFAULT_STATE, type AppState } from '@/types';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

const { diffSyncedCollections, hashRow, readBaseline } = await import('../outbox');
const { applyRemoteChanges, prepareRemoteRows } = await import('../pull');
const { SYNCED_COLLECTIONS, itemsOf, rowIdOf, syncKeyOf } = await import('../syncedCollections');
const { clearTabSyncedHashes, setTabSyncedHashes, storeTabSyncedHashes, storeTabSyncedHashesOver, tabSyncedHashes } =
  await import('../tabVersions');

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const UID = 'u1';
const T0 = '2026-11-20T09:00:00.000Z';
const T1 = '2026-11-21T09:00:00.000Z';
const T_EDIT = '2026-11-22T06:00:00.000Z';
const T2 = '2026-11-22T05:00:00.000Z';
const NOW = '2026-11-22T07:00:00.000Z';
const user = { id: UID, username: 'tester' } as AppState['currentUser'];
const base = (extra: Partial<AppState>) => ({ ...DEFAULT_STATE, currentUser: user, ...extra }) as AppState;

const collectionByTable = (table: string) => SYNCED_COLLECTIONS.find((c) => c.table === table)!;
const hashOf = (table: string, item: unknown) => hashRow(collectionByTable(table).toRow(item as never));
const keyOf = (table: string) => syncKeyOf(collectionByTable(table));
const itemOf = (state: AppState, table: string, id: string) => {
  const collection = collectionByTable(table);
  return itemsOf(collection, state).find((item) => rowIdOf(collection, item) === id);
};

function reset() {
  store.clear();
  clearTabSyncedHashes(UID);
}

/** The device as it cold-boots: baseline = V1 (what the last save sent), stored tab version = V0. */
function seedDevice(table: string, id: string, v0: unknown, v1: unknown) {
  const key = keyOf(table);
  store.set(`ascend_sync_baseline_${UID}`, JSON.stringify({ [key]: { [id]: hashOf(table, v1) } }));
  clearTabSyncedHashes(UID);
  store.set(`ascend_sync_tab_synced_${UID}`, JSON.stringify({ [key]: { [id]: hashOf(table, v0) } }));
}

/** The boot's full pull of the server row (another device's newer V2), applied to the cached state. */
function bootPull(state: AppState, table: string, serverItem: unknown): AppState {
  const collection = collectionByTable(table);
  const row = { ...collection.toRow(serverItem as never), user_id: UID, updated_at: T2, deleted_at: null };
  const changes = prepareRemoteRows(UID, collection, [row], true);
  return applyRemoteChanges(state, changes, UID);
}

/** The save after boot: the ops it would queue for the table. */
function opsAfter(state: AppState, table: string, editTimes = {}) {
  const result = diffSyncedCollections(state, readBaseline(UID), {}, NOW, tabSyncedHashes(UID), {}, editTimes);
  return Object.values(result.outbox).filter((op) => op.table === table);
}

const habit = (name: string, completions: Record<string, unknown>, updatedAt: string) => ({
  id: 'h1',
  name,
  frequency: 'daily',
  points: 10,
  isPreset: false,
  createdAt: T0,
  updatedAt,
  completions,
  missedPeriods: [],
  consecutiveMisses: 0,
});
const tick = (at: string) => ({ done: true, updatedAt: at });
const task = (title: string) => ({ id: 't1', title, priority: 'medium', completed: false, subtasks: [], createdAt: T0 });
const goal = (title: string, manualMode?: boolean) => ({
  id: 'g1',
  title,
  status: 'active',
  createdAt: T0,
  ...(manualMode ? { manualMode: true, manualProgress: 40 } : {}),
});
const ttState = (blocks: unknown[], updatedAt: string) =>
  ({ ...DEFAULT_STATE.timeTracker, dailyLogs: { '2026-11-21': blocks }, dayMeta: { '2026-11-21': { updatedAt } } }) as AppState['timeTracker'];
const block = (endTime: string, updatedAt: string) => ({ id: 'b1', activityId: 'a1', startTime: '09:00', endTime, updatedAt });

interface Case {
  name: string;
  table: string;
  id: string;
  /** The item in state form at V0 (the stored tab version), V1 (cache + baseline), V2 (server). */
  v: (version: 0 | 1 | 2) => unknown;
  /** The cached state holding an item. */
  state: (item: unknown) => Partial<AppState>;
  /** The server row as an item (time tracker days: the day row, not the state). */
  serverItem: () => unknown;
  /** A real unsent edit made on this device after V1 (S2). */
  edit: () => unknown;
}

// A day holds b1 and, from V1 on, b2. The other device's V2 was written from a copy without b2 (no
// deletedBlockIds), so merging V1 into it would bring b2 back and upload the merge.
const b2 = { id: 'b2', activityId: 'a1', startTime: '12:00', endTime: '13:00', updatedAt: T1 };
const ttDay = (endTime: string, at: string, withB2: boolean) => ({
  date: '2026-11-21',
  blocks: withB2 ? [block(endTime, at), b2] : [block(endTime, at)],
  updatedAt: at,
});

const cases: Case[] = [
  {
    name: 'habits rename (jsonb document)',
    table: 'habits',
    id: 'h1',
    v: (n) => habit(n === 0 ? 'Read' : n === 1 ? 'Read-v1' : 'Read-v2-other-device', {}, n === 0 ? T0 : n === 1 ? T1 : T2),
    state: (item) => ({ habits: [item as never] }),
    serverItem: () => habit('Read-v2-other-device', {}, T2),
    edit: () => habit('Read-edited-offline', {}, T_EDIT),
  },
  {
    name: 'habits tick (jsonb document)',
    table: 'habits',
    id: 'h1',
    v: (n) =>
      habit(
        'Pray',
        n === 0 ? {} : n === 1 ? { '2026-11-21': tick(T1) } : { '2026-11-21': tick(T1), '2026-11-20': tick(T2) },
        n === 0 ? T0 : n === 1 ? T1 : T2
      ),
    state: (item) => ({ habits: [item as never] }),
    serverItem: () => habit('Pray', { '2026-11-21': tick(T1), '2026-11-20': tick(T2) }, T2),
    edit: () => habit('Pray', { '2026-11-21': tick(T1), '2026-11-22': tick(T_EDIT) }, T_EDIT),
  },
  {
    name: 'tasks (relational, whole row)',
    table: 'tasks',
    id: 't1',
    v: (n) => task(n === 0 ? 'Task' : n === 1 ? 'Task-v1' : 'Task-v2-other-device'),
    state: (item) => ({ tasks: [item as never] }),
    serverItem: () => task('Task-v2-other-device'),
    edit: () => task('Task-edited-offline'),
  },
  {
    name: 'goals (relational, manual_mode false left out of the hash)',
    table: 'goals',
    id: 'g1',
    v: (n) => goal(n === 0 ? 'Goal' : n === 1 ? 'Goal-v1' : 'Goal-v2-other-device'),
    state: (item) => ({ goals: [item as never] }),
    serverItem: () => goal('Goal-v2-other-device'),
    edit: () => goal('Goal-edited-offline'),
  },
  {
    name: 'goals set by hand (manual_mode true)',
    table: 'goals',
    id: 'g1',
    v: (n) => goal(n === 0 ? 'Goal' : n === 1 ? 'Goal-v1' : 'Goal-v2-other-device', true),
    state: (item) => ({ goals: [item as never] }),
    serverItem: () => goal('Goal-v2-other-device', true),
    edit: () => goal('Goal-edited-offline', true),
  },
  {
    name: 'time_tracker_days (merge branch)',
    table: 'time_tracker_days',
    id: '2026-11-21',
    v: (n) => ttDay(n === 0 ? '10:00' : n === 1 ? '10:30' : '11:00', n === 0 ? T0 : n === 1 ? T1 : T2, n === 1),
    state: (item) => {
      const day = item as ReturnType<typeof ttDay>;
      return { timeTracker: ttState(day.blocks, day.updatedAt) };
    },
    serverItem: () => ttDay('11:00', T2, false),
    edit: () => ttDay('10:45', T_EDIT, true),
  },
];

for (const c of cases) {
  // The case's own V0/V1/V2 must hash apart, or the test proves nothing.
  const [h0, h1, h2] = [0, 1, 2].map((n) => hashOf(c.table, c.v(n as 0 | 1 | 2)));
  assert(h0 !== h1 && h1 !== h2 && h0 !== h2, `${c.name}: V0, V1, V2 hash apart`);

  // S1: the cached copy equals the baseline (synced); the stored tab version lags (V0).
  {
    reset();
    seedDevice(c.table, c.id, c.v(0), c.v(1));
    const after = bootPull(base(c.state(c.v(1))), c.table, c.serverItem());
    const shown = itemOf(after, c.table, c.id);
    assert(hashOf(c.table, shown) === hashOf(c.table, c.serverItem()), `${c.name}: S1 the boot shows the server's newer row`);
    assert(opsAfter(after, c.table).length === 0, `${c.name}: S1 nothing is uploaded after the boot`);
    assert(
      tabSyncedHashes(UID)[keyOf(c.table)][c.id] === hashOf(c.table, c.serverItem()),
      `${c.name}: S1 the tab's version moves to the server row`
    );
  }

  // S2: a real unsent edit (neither the baseline nor the tab version) is kept and uploaded, with its
  // edit time (checked where editTimes carry it; a merged time tracker day carries its own).
  {
    reset();
    seedDevice(c.table, c.id, c.v(0), c.v(1));
    const edited = c.edit();
    const after = bootPull(base(c.state(edited)), c.table, c.serverItem());
    const shown = itemOf(after, c.table, c.id);
    if (c.table === 'time_tracker_days') {
      // A merging table merges the two: the local block edit is newer and kept.
      const blocks = (shown as ReturnType<typeof ttDay>).blocks;
      assert(blocks.some((b) => b.endTime === '10:45'), `${c.name}: S2 the local edit survives the merge`);
    } else {
      assert(hashOf(c.table, shown) === hashOf(c.table, edited), `${c.name}: S2 the unsent edit is kept`);
    }
    const editHash = hashOf(c.table, shown);
    const editTimes = { [keyOf(c.table)]: { [c.id]: [editHash, T_EDIT] as [string, string] } };
    const ops = opsAfter(after, c.table, editTimes);
    assert(ops.length === 1 && ops[0].kind === 'upsert', `${c.name}: S2 the unsent edit is uploaded`);
    if (c.table !== 'time_tracker_days') {
      const at = (ops[0] as { updatedAt?: string }).updatedAt;
      assert(at === T_EDIT, `${c.name}: S2 the upload carries the edit time, not now (got ${at})`);
    }
  }

  // Unchanged behaviour: a copy at this tab's own version (another tab moved the baseline) still
  // takes the server row and uploads nothing.
  {
    reset();
    seedDevice(c.table, c.id, c.v(0), c.v(1));
    const after = bootPull(base(c.state(c.v(0))), c.table, c.serverItem());
    assert(
      hashOf(c.table, itemOf(after, c.table, c.id)) === hashOf(c.table, c.serverItem()),
      `${c.name}: a copy at the tab's own version takes the server row`
    );
    assert(opsAfter(after, c.table).length === 0, `${c.name}: and uploads nothing`);
  }
}
console.log('  ok  S1/S2 stale boot versions (habits rename + tick, tasks, goals, manual goal, time tracker days)');

// F2 helper: stores this tab's versions only over the stored versions this tab held.
{
  reset();
  const held = { habits: { h1: 'v0' } };
  setTabSyncedHashes(UID, held);
  storeTabSyncedHashes(UID);
  setTabSyncedHashes(UID, { habits: { h1: 'v1' } });
  storeTabSyncedHashesOver(UID, held);
  assert(store.get(`ascend_sync_tab_synced_${UID}`) === JSON.stringify({ habits: { h1: 'v1' } }), 'F2: stored over its own versions');

  // Another tab wrote the shared cache and its versions meanwhile: left alone.
  const other = JSON.stringify({ habits: { h1: 'other-tab' } });
  store.set(`ascend_sync_tab_synced_${UID}`, other);
  const heldNow = tabSyncedHashes(UID);
  setTabSyncedHashes(UID, { habits: { h1: 'v2' } });
  storeTabSyncedHashesOver(UID, heldNow);
  assert(store.get(`ascend_sync_tab_synced_${UID}`) === other, "F2: another tab's stored versions are not overwritten");

  // Nothing stored yet (first save on the device): left alone, as before.
  store.delete(`ascend_sync_tab_synced_${UID}`);
  storeTabSyncedHashesOver(UID, heldNow);
  assert(!store.has(`ascend_sync_tab_synced_${UID}`), 'F2: nothing stored when nothing was stored by this tab');
}
console.log('  ok  F2 storeTabSyncedHashesOver');
console.log('staleBootVersions: OK');
