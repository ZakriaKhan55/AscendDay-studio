// Hook test (real useAppState + in-process fake Supabase, see harness/): undoing an early start
// gives the end time back only to the block that was trimmed for it (CodeRabbit CR-04-17, 2026-11-14).
//   T40  a block finished early on its own (09:00-10:00 done at 09:30) stays 09:00-09:30 when a later
//        block pulled forward to 09:45 is undone; that block goes back to 10:00-11:00.
//   T41  a block trimmed for an early start (trimmedDueToPullId) gets its end time back on undo.
import { bootHook, story, until, quiet, eq, pass, server, UID } from './harness/bootHook';

const blobAt = 'Sun 2026-11-01 5:00 AM PKT (UTC+05:00)';

await story('timeTrackerUndoEarly.hook (undo early start)', async () => {
  const { todayKey, addDays } = await import('../time/dates');
  const day = addDays(todayKey(), 1);
  const at = blobAt;
  const done = {
    id: 'tt-done', activityId: 'deep_work', startTime: '09:00', endTime: '09:30', trimmedOriginalEndTime: '10:00',
    completed: true, completedAt: at, createdAt: at, updatedAt: at,
  };
  const pulled = {
    id: 'tt-pulled', activityId: 'deep_work', startTime: '09:45', endTime: '11:00', originalStartTime: '10:00', originalEndTime: '11:00',
    pulledForwardTriggerId: 'tt-done', createdAt: at, updatedAt: at,
  };
  const trimmed = {
    id: 'tt-trimmed', activityId: 'deep_work', startTime: '12:00', endTime: '12:30', trimmedOriginalEndTime: '13:00',
    trimmedDueToPullId: 'tt-pulled2', createdAt: at, updatedAt: at,
  };
  const pulled2 = {
    id: 'tt-pulled2', activityId: 'deep_work', startTime: '12:30', endTime: '14:00', originalStartTime: '13:00', originalEndTime: '14:00',
    createdAt: at, updatedAt: at,
  };
  server.blob.set(UID, { state: { username: 'hooktester', lastSeenRelease: 100 }, updated_at: blobAt });
  server.upsert(
    'time_tracker_days',
    [{ id: day, user_id: UID, data: { date: day, blocks: [done, pulled, trimmed, pulled2], updatedAt: at }, updated_at: at }],
    'seed'
  );
  const h = await bootHook({ as: 'signedIn' });
  await until(h.loaded, 'signed-in boot loaded');
  const block = (id: string) => (h.s().state.timeTracker?.dailyLogs?.[day] || []).find((b) => b.id === id);
  await until(() => block('tt-done') && block('tt-pulled2'), 'seeded day on screen');
  await quiet(1000);

  // T40
  h.s().undoEarlyStartTimeBlock(day, 'tt-pulled');
  await until(() => block('tt-pulled')?.startTime === '10:00', 'T40: pulled block back at 10:00');
  eq(block('tt-pulled')!.endTime, '11:00', 'T40: pulled block ends at 11:00 again');
  eq(block('tt-done')!.endTime, '09:30', 'T40: the block finished early keeps its real end (not 10:00)');
  eq(block('tt-done')!.trimmedOriginalEndTime, '10:00', 'T40: its planned end stays recorded');
  pass('T40 undo early start leaves an unrelated block finished early as it was');

  // T41
  h.s().undoEarlyStartTimeBlock(day, 'tt-pulled2');
  await until(() => block('tt-pulled2')?.startTime === '13:00', 'T41: second pulled block back at 13:00');
  eq(block('tt-trimmed')!.endTime, '13:00', 'T41: the block trimmed for it ends at 13:00 again');
  eq(block('tt-trimmed')!.trimmedDueToPullId, undefined, 'T41: its link is cleared');
  pass('T41 undo early start restores the block trimmed for it');
});
