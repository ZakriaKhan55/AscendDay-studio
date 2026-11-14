// CodeRabbit phase 2 sync fixes (knowledge/mode-a-cr-p2-sync-2026-11-14.md):
// CR-06-3: a row missing from the state without a tombstone keeps its baseline entry, so a later
//          delete of it is still sent to the server.
// CR-06-6: one table's thrown failure in a pull (device storage full) no longer rejects the whole
//          pull: the other tables' changes are returned, the failed table keeps its cursor.
import { DEFAULT_STATE, type AppState } from '@/types';

const store = new Map<string, string>();
let failWrite: ((key: string, value: string) => boolean) | null = null;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    if (failWrite?.(k, String(v))) throw new Error('QuotaExceededError');
    store.set(k, String(v));
  },
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};
(globalThis as { window?: unknown }).window = {
  location: { hash: '', search: '', pathname: '/' },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
};
(globalThis as { CustomEvent?: unknown }).CustomEvent ??= class {
  type: string;
  detail: unknown;
  constructor(type: string, init?: { detail?: unknown }) {
    this.type = type;
    this.detail = init?.detail;
  }
};

const { diffSyncedCollections, hashRow } = await import('../outbox');
const { pullSyncedRows } = await import('../pull');
const { SYNCED_COLLECTIONS } = await import('../syncedCollections');
const { clearTabSyncedHashes } = await import('../tabVersions');
const { supabase } = await import('../../auth/supabase');

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const UID = 'u1';
const T0 = '2026-11-02T16:50:00.000Z';
const LATER = '2026-11-05T05:00:00.000Z';
const user = { id: UID, username: 'zakria' } as AppState['currentUser'];
const base = (extra: Partial<AppState>) => ({ ...DEFAULT_STATE, currentUser: user, ...extra }) as AppState;
const byTable = (table: string) => SYNCED_COLLECTIONS.find((c) => c.table === table)!;
const task = (id: string, title: string) => ({ id, title, priority: 'medium', completed: false, subtasks: [], createdAt: T0 }) as never;
const habit = (id: string, name: string) =>
  ({ id, name, frequency: 'daily', points: 1, isPreset: false, createdAt: T0, createdAtPeriod: '2026-11-02', completions: {} }) as never;
const row = (table: string, item: unknown, at: string) => ({
  ...byTable(table).toRow(item as never),
  user_id: UID,
  updated_at: at,
  server_updated_at: at,
  deleted_at: null,
});
const baselineKey = `ascend_sync_baseline_${UID}`;
const cursorKey = (table: string) => `ascend_sync_cursor_${UID}_${table}`;

function reset() {
  store.clear();
  failWrite = null;
  clearTabSyncedHashes(UID);
}

// ---------------------------------------------------------------- CR-06-3: baseline kept, later delete sent
{
  reset();
  const s0 = base({ tasks: [task('t1', 'Essay'), task('t2', 'Other')] });
  const first = diffSyncedCollections(s0, {}, {}, T0, {});
  const t1Hash = hashRow(byTable('tasks').toRow(task('t1', 'Essay')));
  assert(first.baseline.tasks?.t1 === t1Hash, 'synced: t1 in the baseline');

  // t1 drops out of the state without a tombstone (a bad merge): nothing is deleted on the server.
  // (first.outbox was sent: the next diff starts from an empty outbox.)
  const missing = diffSyncedCollections(base({ tasks: [task('t2', 'Other')] }), first.baseline, {}, T0, first.tabHashes);
  assert(Object.keys(missing.outbox).length === 0, 'a row only missing from the state is never deleted');
  assert(missing.baseline.tasks?.t1 === t1Hash, 'the baseline keeps the row the server still has');

  // A later state deletes t1 for real (its tombstone): the delete is still sent.
  const deleted = diffSyncedCollections(
    base({ tasks: [task('t2', 'Other')], deletedEntityIds: ['t1'] }),
    missing.baseline,
    missing.outbox,
    T0,
    missing.tabHashes
  );
  assert(deleted.outbox['tasks:t1']?.kind === 'delete', 'the later delete reaches the outbox');
  assert(deleted.baseline.tasks?.t1 === '', 'the baseline marks t1 deleted');
}

/** A fake client whose selects answer from `server` (key `table:id`). */
function fakeClient(server: Map<string, Record<string, unknown>>) {
  const client = supabase as unknown as { from: unknown; auth: { getSession: unknown } };
  client.auth.getSession = async () => ({ data: { session: { user: { id: UID } } } });
  client.from = (table: string) => {
    const query = {
      select: () => query,
      eq: () => query,
      in: () => query,
      gt: () => query,
      order: () => query,
      range: () => query,
      then: (resolve: (r: unknown) => void) => {
        const rows = [...server.entries()].filter(([k]) => k.startsWith(`${table}:`)).map(([, r]) => r);
        resolve({ data: rows, error: null });
      },
    };
    return query;
  };
}

const server = new Map<string, Record<string, unknown>>();
server.set('tasks:t1', row('tasks', task('t1', 'Essay'), LATER));
server.set('habits:h1', row('habits', habit('h1', 'Run'), LATER));
fakeClient(server);

// ---------------------------------------------------------------- CR-06-6: one table throws, the rest arrive
{
  reset();
  // Storage full exactly when the habits table writes its baseline.
  failWrite = (key, value) => key === baselineKey && Boolean((JSON.parse(value) as Record<string, Record<string, string>>).habits?.h1);
  let result: Awaited<ReturnType<typeof pullSyncedRows>> | null = null;
  let rejected: unknown = null;
  try {
    result = await pullSyncedRows(UID, true);
  } catch (err) {
    rejected = err;
  }
  assert(rejected === null, `the pull resolves when one table throws (got ${String(rejected)})`);
  assert(result!.everyTableRead === false, 'the pull reports that a table was not read');
  assert(result!.changes.some((c) => c.key === 'tasks' && c.id === 't1' && c.item !== null), "the other tables' changes are returned");
  assert(!result!.changes.some((c) => c.key === 'habits' && c.id === 'h1'), "the failed table's rows are not returned");
  assert(!store.has(cursorKey('habits')), 'the failed table keeps its cursor');
  assert(store.has(cursorKey('tasks')), 'the read tables move their cursor');
  assert(!store.has(`ascend_sync_last_full_pull_${UID}`), 'not recorded as a full pull');
}

// ---------------------------------------------------------------- CR-06-6: cursor write fails, rows still applied
{
  reset();
  failWrite = (key) => key === cursorKey('tasks');
  const result = await pullSyncedRows(UID, false);
  assert(result.changes.some((c) => c.key === 'tasks' && c.id === 't1' && c.item !== null), 'rows the baseline took are returned');
  assert(Boolean(JSON.parse(store.get(baselineKey) || '{}').tasks?.t1), 'the baseline holds them');
  assert(!store.has(cursorKey('tasks')), 'the cursor stays, so they are read again');
  assert(result.everyTableRead === true, 'the table was read');
}

console.log('baselinePullFixes: all passed');
