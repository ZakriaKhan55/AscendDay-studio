// Hook test (real useAppState + in-process fake Supabase, see harness/): after an edit and its save,
// with no later state change, the tab's row versions stored next to the device cache equal the
// shared baseline (S3). Before, they were stored with the cache before the save's diff moved them,
// so a tab closed at that point cold-booted one save behind and took its synced rows for unsent
// edits (knowledge/mode-a-stale-copy-rollback-2026-11-22.md; the boot side: staleBootVersions.hook).
import { bootHook, story, until, quiet, rows, assert, pass, server, UID, habit, seedServerHabits } from './harness/bootHook';

const blobAt = '2026-11-01T00:00:00.000Z';

await story('staleBootSave.hook (stored tab versions follow the save)', async () => {
  server.blob.set(UID, { state: { username: 'hooktester', lastSeenRelease: 100 }, updated_at: blobAt });
  seedServerHabits(habit('h1', 'TickMe', { createdAt: blobAt, updatedAt: blobAt }), habit('h2', 'RenameMe', { createdAt: blobAt, updatedAt: blobAt }));
  const h = await bootHook({ as: 'signedIn' });
  await until(h.loaded, 'signed-in boot loaded');
  await quiet(1500);

  const { cacheFingerprint } = await import('../sync/tabVersions');
  const stored = (key: string) => JSON.parse(h.storage.getItem(key) || '{}');
  // The stored record must be v2 and paired with the cache now stored (else a boot ignores it).
  const inStep = (collection: string, id: string) => {
    const base = stored(`ascend_sync_baseline_${UID}`)[collection]?.[id];
    const record = stored(`ascend_sync_tab_synced_${UID}`);
    const paired = record.v === 2 && record.cache === cacheFingerprint(h.storage.getItem(`ascend_user_cache_${UID}`) || '');
    const tab = record.hashes?.[collection]?.[id];
    return { ok: paired && base !== undefined && base === tab, base, tab, paired };
  };

  h.s().toggleHabit('h1');
  await until(() => rows('habits').some((r) => r.id === 'h1' && Object.keys(r.data?.completions || {}).length > 0), 'tick reached server', 5000);
  await quiet(1500);
  const tick = inStep('habits', 'h1');
  assert(tick.ok, `S3: after the tick's save the stored tab version, paired with the cache, equals the baseline (baseline ${tick.base}, stored ${tick.tab}, paired ${tick.paired})`);
  pass('S3 tick: stored tab version = baseline');

  h.s().renameHabit('h2', 'H2-v1');
  await until(() => rows('habits').some((r) => r.id === 'h2' && r.data?.name === 'H2-v1'), 'rename reached server', 5000);
  await quiet(1500);
  const rename = inStep('habits', 'h2');
  assert(rename.ok, `S3: after the rename's save the stored tab version, paired with the cache, equals the baseline (baseline ${rename.base}, stored ${rename.tab}, paired ${rename.paired})`);
  pass('S3 rename: stored tab version = baseline');

  h.s().createTask({ title: 'Task-v1' });
  const task = () => h.s().state.tasks.find((t) => t.title === 'Task-v1');
  await until(() => task() && rows('tasks').some((r) => r.id === task()!.id), 'task reached server', 5000);
  await quiet(1500);
  const created = inStep('tasks', task()!.id);
  assert(created.ok, `S3: after a new task's save the stored tab version, paired with the cache, equals the baseline (baseline ${created.base}, stored ${created.tab}, paired ${created.paired})`);
  pass('S3 new task: stored tab version = baseline');
});
