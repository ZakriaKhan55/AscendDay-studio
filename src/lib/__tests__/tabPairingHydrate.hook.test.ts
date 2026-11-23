// Hook test (fake Supabase): a cold boot takes the device cache and its row versions from one read
// (readDeviceCacheSnapshot at the start of hydrateUserSession). Another tab writes a new cache and
// its versions while the boot's reads are in flight; the boot's cached collections, device-local
// keys and row versions must all still come from the cache it started from (before: the versions
// were read during the table pull and the cache after every read, so they could come from two
// different cache writes). A tab that already holds versions keeps its own.
// The app boots signed in first (bootHook), then the case calls hydrateUserSession directly.
import { bootHook, story, until, quiet, eq, assert, pass, fake, UID } from './harness/bootHook';
import { EMAIL } from './harness/fakeSupabase';

const CACHE_KEY = `ascend_user_cache_${UID}`;
const VERSIONS_KEY = `ascend_sync_tab_synced_${UID}`;
const at = 'Sun 2026-11-01 5:00 AM PKT (UTC+05:00)';
const cacheOf = (tag: string) =>
  JSON.stringify({
    currentUser: { id: UID, username: 'hooktester' },
    tasks: [{ id: `task-${tag}`, title: `Task ${tag}`, priority: 'medium', completed: false, subtasks: [], createdAt: at }],
    deletedEntityIds: [`gone-${tag}`],
  });

await story('tabPairingHydrate.hook (boot reads the cache and its versions once)', async () => {
  const h = await bootHook({ as: 'signedIn' });
  await until(h.loaded, 'signed-in boot loaded');
  await quiet(1500);
  const { hydrateUserSession } = await import('../auth/authSession');
  const { cacheFingerprint, setTabSyncedHashes, tabSyncedHashes } = await import('../sync/tabVersions');
  const { SYNCED_COLLECTIONS } = await import('../sync/syncedCollections');
  const syncedTables = new Set(SYNCED_COLLECTIONS.map((c) => c.table));
  const record = (cacheJson: string, hashes: unknown) => JSON.stringify({ v: 2, cache: cacheFingerprint(cacheJson), hashes });
  const cacheA = cacheOf('A');
  const cacheB = cacheOf('B');
  const versionsA = { tasks: { 'task-A': 'version-a' } };
  const versionsB = { tasks: { 'task-B': 'version-b' } };

  const ids = (list: unknown) => ((list as { id: string }[] | undefined) || []).map((x) => x.id);
  async function bootWhileOtherTabWrites() {
    h.storage.setItem(CACHE_KEY, cacheA);
    h.storage.setItem(VERSIONS_KEY, record(cacheA, versionsA));
    // The settings read and the table pull wait, so nothing of the boot reads storage after its start.
    const held = fake.hold((r) => r.method === 'GET' && (r.table === 'user_data' || syncedTables.has(r.table)));
    const loading = hydrateUserSession(UID, EMAIL, null);
    await until(() => held.hits > 0, 'the boot reads are in flight');
    await quiet(300);
    // Another tab writes its cache and versions (a matching pair) before the boot's reads finish.
    h.storage.setItem(CACHE_KEY, cacheB);
    h.storage.setItem(VERSIONS_KEY, record(cacheB, versionsB));
    held.release();
    return loading;
  }

  // Cold boot: no versions in memory for this account yet.
  setTabSyncedHashes('another-account', {});
  const cold = await bootWhileOtherTabWrites();
  eq(ids(cold.state.tasks).filter((id) => id.startsWith('task-')), ['task-A'], 'cold boot: the cached tasks come from the cache it started from');
  assert(
    (cold.state.deletedEntityIds || []).includes('gone-A') && !(cold.state.deletedEntityIds || []).includes('gone-B'),
    `cold boot: the device-local keys come from that cache too (got ${JSON.stringify(cold.state.deletedEntityIds)})`
  );
  const versions = tabSyncedHashes(UID);
  assert(versions.tasks?.['task-A'] === 'version-a' && versions.tasks?.['task-B'] === undefined, `cold boot: the versions come from the same read (got ${JSON.stringify(versions)})`);
  pass('cold boot: cached state and row versions from one cache write');

  // A tab that already holds versions keeps them (the snapshot does not replace them).
  const own = { tasks: { 'task-A': 'this-tab' } };
  setTabSyncedHashes(UID, own);
  await bootWhileOtherTabWrites();
  eq(tabSyncedHashes(UID).tasks?.['task-A'], 'this-tab', 'a running tab keeps its own versions');
  pass('running tab keeps its own versions');
});
