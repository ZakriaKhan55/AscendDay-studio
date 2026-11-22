// Shared story for staleBootVersions.hook.test.ts (and its StrictMode twin): a cold boot from a
// device cache whose stored tab versions lag one save behind the shared baseline, after another
// device made newer edits. Incident: knowledge/mode-a-stale-copy-rollback-2026-11-22.md.
//   Device cache = V1 (what its last save sent; baseline V1), stored tab versions = V0 (stored with
//   the cache before that save's diff). Server = V2 (the other device's newer edits):
//   h1 ticked on another day, h2 renamed, task t1 retitled. Plus goal g1 with a real unsent edit
//   in the cache (cache ≠ baseline and ≠ tab version, server unchanged).
//   S1  every state after load shows V2 for h1, h2, t1; no write to habits or tasks within 4 s;
//       the server rows keep their updated_at and content.
//   S2  the goal's unsent edit is kept and uploaded.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { bootHook, story, until, quiet, rows, assert, pass, server, fake, UID } from './bootHook';
import { win } from './dom';

const blobAt = '2026-11-01T00:00:00.000Z';
const t0 = '2026-11-01T00:00:00.000Z';
const t1 = '2026-11-03T10:00:00.000Z';
const day = (at: string) => ({ done: true, updatedAt: at });
const habitItem = (id: string, name: string, completions: Record<string, unknown>, updatedAt: string) => ({
  id,
  name,
  frequency: 'daily',
  points: 10,
  isPreset: false,
  createdAt: t0,
  updatedAt,
  completions,
  missedPeriods: [],
  consecutiveMisses: 0,
});
const taskItem = (title: string) => ({ id: 't1', title, priority: 'medium', completed: false, subtasks: [], createdAt: t0 });
const goalItem = (title: string) => ({ id: 'g1', title, status: 'active', createdAt: t0 });

export async function runStaleBoot(name: string, strict: boolean) {
  await story(name, async () => {
    // eslint-disable-next-line no-restricted-syntax -- the other device's edit, a minute ago
    const otherAt = new Date(server.nowMs() - 60_000).toISOString();
    const v = {
      h1: [
        habitItem('h1', 'TickMe', {}, t0),
        habitItem('h1', 'TickMe', { '2026-11-03': day(t1) }, t1),
        habitItem('h1', 'TickMe', { '2026-11-03': day(t1), '2026-11-02': day(otherAt) }, otherAt),
      ],
      h2: [habitItem('h2', 'RenameMe', {}, t0), habitItem('h2', 'H2-v1', {}, t1), habitItem('h2', 'H2-v2-other-device', {}, otherAt)],
      t1: [taskItem('Task'), taskItem('Task-v1'), taskItem('Task-v2-other-device')],
    };
    const goalSynced = goalItem('Goal');
    const goalEdited = goalItem('Goal-edited-offline');

    server.blob.set(UID, { state: { username: 'hooktester', lastSeenRelease: 100 }, updated_at: blobAt });

    const shownAfterLoad: ReturnType<typeof snapshot>[] = [];
    const h = await bootHook({
      as: 'signedIn',
      strict,
      beforeRender: async () => {
        const { SYNCED_COLLECTIONS } = await import('../../sync/syncedCollections');
        const { hashRow } = await import('../../sync/rowHash');
        const col = (table: string) => SYNCED_COLLECTIONS.find((c) => c.table === table)!;
        const hash = (table: string, item: unknown) => hashRow(col(table).toRow(item as never));
        const serverRow = (table: string, item: any, updatedAt: string) => ({ ...col(table).toRow(item as never), user_id: UID, updated_at: updatedAt });

        server.upsert('habits', [serverRow('habits', v.h1[2], otherAt), serverRow('habits', v.h2[2], otherAt)], 'other-device');
        server.upsert('tasks', [serverRow('tasks', v.t1[2], otherAt)], 'other-device');
        server.upsert('goals', [serverRow('goals', goalSynced, t1)], 'other-device');

        const ls = win.localStorage as Storage;
        ls.setItem(
          `ascend_user_cache_${UID}`,
          JSON.stringify({
            currentUser: { id: UID, username: 'hooktester', email: 'hook@test.local', avatar: '🧑', createdAt: '2026-10-01T00:00:00.000Z' },
            username: 'hooktester',
            lastSeenRelease: 100,
            habits: [v.h1[1], v.h2[1]],
            tasks: [v.t1[1]],
            goals: [goalEdited],
          })
        );
        ls.setItem(
          `ascend_sync_baseline_${UID}`,
          JSON.stringify({
            habits: { h1: hash('habits', v.h1[1]), h2: hash('habits', v.h2[1]) },
            tasks: { t1: hash('tasks', v.t1[1]) },
            goals: { g1: hash('goals', goalSynced) },
          })
        );
        ls.setItem(
          `ascend_sync_tab_synced_${UID}`,
          JSON.stringify({
            habits: { h1: hash('habits', v.h1[0]), h2: hash('habits', v.h2[0]) },
            tasks: { t1: hash('tasks', v.t1[0]) },
            goals: { g1: hash('goals', goalSynced) },
          })
        );
        // eslint-disable-next-line no-restricted-syntax -- the device's last full pull, an hour ago
        ls.setItem(`ascend_sync_last_full_pull_${UID}`, new Date(server.nowMs() - 3_600_000).toISOString());
        ls.setItem(`ascend_outbox_${UID}`, '{}');
        fake.resetCounts();
      },
      // Every state shown once the account is loaded (so a V1 that flashed and healed still fails).
      use: (store: any) => {
        const loaded = store.state.currentUser?.id === UID && !store.isAuthChecking && !store.isSessionLoading && store.isServerDataApplied;
        if (loaded) shownAfterLoad.push(snapshot(store.state));
        return null;
      },
    });
    await until(h.loaded, 'signed-in boot loaded');
    const serverBefore = {
      h1: rows('habits').find((r: any) => r.id === 'h1')?.updated_at,
      h2: rows('habits').find((r: any) => r.id === 'h2')?.updated_at,
      t1: rows('tasks').find((r: any) => r.id === 't1')?.updated_at,
    };
    assert(shownAfterLoad.length > 0, 'a loaded state was rendered');
    const first = shownAfterLoad[0];
    assert(first.h2 === 'H2-v2-other-device', `S1: first state after load shows the other device's rename (got ${first.h2})`);
    assert(first.t1 === 'Task-v2-other-device', `S1: first state after load shows the other device's task title (got ${first.t1})`);
    assert(first.h1.join() === '2026-11-02,2026-11-03', `S1: first state after load has both ticks (got ${first.h1.join()})`);
    pass('S1 first state after load = server rows');

    await quiet(4000);
    for (const s of shownAfterLoad) {
      assert(s.h2 === 'H2-v2-other-device' && s.t1 === 'Task-v2-other-device', `S1: no loaded state showed the old copy (${JSON.stringify(s)})`);
    }
    const writes = fake.log.filter((r: any) => r.method !== 'GET' && r.method !== 'HEAD' && (r.table === 'habits' || r.table === 'tasks'));
    assert(writes.length === 0, `S1: no write to habits or tasks at boot (got ${JSON.stringify(writes.map((w: any) => ({ m: w.method, t: w.table, body: w.body })))})`);
    const h2Row = rows('habits').find((r: any) => r.id === 'h2');
    const t1Row = rows('tasks').find((r: any) => r.id === 't1');
    assert(h2Row?.data?.name === 'H2-v2-other-device' && t1Row?.title === 'Task-v2-other-device', 'S1: the server keeps the newer rows');
    assert(
      h2Row?.updated_at === serverBefore.h2 && t1Row?.updated_at === serverBefore.t1 && rows('habits').find((r: any) => r.id === 'h1')?.updated_at === serverBefore.h1,
      'S1: server updated_at unchanged'
    );
    pass('S1 zero writes to habits/tasks, server untouched');

    await until(() => rows('goals').find((r: any) => r.id === 'g1')?.title === 'Goal-edited-offline', 'S2: the unsent goal edit reached the server', 6000);
    assert(h.s().state.goals.find((g: any) => g.id === 'g1')?.title === 'Goal-edited-offline', 'S2: the unsent goal edit is kept on screen');
    pass('S2 a real unsent edit is kept and uploaded');
  });
}

function snapshot(state: any) {
  const habit = (id: string) => state.habits.find((x: any) => x.id === id);
  return {
    h1: Object.keys(habit('h1')?.completions || {}).sort(),
    h2: habit('h2')?.name,
    t1: state.tasks.find((t: any) => t.id === 't1')?.title,
  };
}
