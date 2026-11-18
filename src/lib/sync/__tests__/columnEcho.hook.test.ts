// Hook test (real useAppState + in-process fake Supabase, see src/lib/__tests__/harness/): on the
// column tables (dropsOwnStaleEchoes: goals, journal_entries, ...), a late realtime echo of an earlier
// save must not undo a newer one. Judged by the updated_at the server stored for this device's own
// last write of the row (ownWrites.ts), since these items carry no updatedAt.
//   T35  goals: save A then B, A's echo after B's reply leaves B (P1); an edit made right after the
//        late echo keeps B on the server (P3, was lost for good before the fix).
//   T36  a newer row from another device is still taken; a delete is always taken, even one whose
//        updated_at is older than this device's last write.
//   T37  journal_entries: the same late echo leaves the edited text.
import { bootHook, story, until, quiet, rows, eq, pass, server, UID } from '../../__tests__/harness/bootHook';

const blobAt = '2026-11-01T00:00:00.000Z';
const later = (iso: unknown) => new Date(Date.parse(String(iso)) + 60_000).toISOString();
const earlier = (iso: unknown) => new Date(Date.parse(String(iso)) - 60_000).toISOString();

await story('columnEcho.hook (late realtime echo on column tables)', async () => {
  server.blob.set(UID, { state: { username: 'hooktester', lastSeenRelease: 100 }, updated_at: blobAt });
  const h = await bootHook({ as: 'signedIn' });
  await until(h.loaded, 'signed-in boot loaded');
  await quiet(1500);

  // ── T35 goals: P1 and P3 ──
  type GoalRow = { id: string; title?: string; description?: string | null; category?: string | null; updated_at?: string; deleted_at?: string | null };
  const g = h.s().createGoal({ title: 'EchoGoal' });
  const id = g.id;
  const row = () => rows('goals').find((r: GoalRow) => r.id === id) as GoalRow | undefined;
  const local = () => h.s().state.goals.find((x) => x.id === id);
  await until(() => row(), 'T35: goal row saved', 5000);
  await quiet(50);

  h.s().updateGoal(id, { title: 'A' });
  await until(() => row()?.title === 'A', 'T35: save A', 5000);
  const echoA = structuredClone(row()!);
  await quiet(50);
  h.s().updateGoal(id, { description: 'B' });
  await until(() => row()?.description === 'B', 'T35: save B', 5000);
  await quiet(800);

  server.emit('goals', structuredClone(echoA), 'UPDATE');
  await quiet(800);
  eq(local()?.description, 'B', 'T35 P1: a late echo of save A leaves save B on this device');
  eq(local()?.title, 'A', 'T35 P1: title from save A still there');

  server.emit('goals', structuredClone(echoA), 'UPDATE');
  await quiet(100);
  h.s().updateGoal(id, { category: 'C' });
  await until(() => row()?.category === 'C', 'T35: save C', 5000);
  await quiet(800);
  eq({ t: row()?.title, d: row()?.description, c: row()?.category }, { t: 'A', d: 'B', c: 'C' }, 'T35 P3: an edit right after a late echo keeps save B on the server');
  eq({ d: local()?.description, c: local()?.category }, { d: 'B', c: 'C' }, 'T35 P3: and on this device');
  pass('T35 a late echo of an earlier goal save never undoes the newer one (P1), nor loses it (P3)');

  // ── T36 other device: newer edit applies, delete always applies ──
  const newer = structuredClone(row()!);
  newer.title = 'FromOtherDevice';
  newer.updated_at = later(newer.updated_at);
  server.emit('goals', newer, 'UPDATE');
  await until(() => local()?.title === 'FromOtherDevice', 'T36: a newer goal row from another device is taken');

  const deleted = structuredClone(row()!);
  deleted.updated_at = earlier(deleted.updated_at);
  deleted.deleted_at = deleted.updated_at;
  server.emit('goals', deleted, 'UPDATE');
  await until(() => !local(), 'T36: a delete from another device is taken, even with an older updated_at');
  pass('T36 newer rows from another device and deletes still apply');

  // ── T37 journal_entries ──
  type JournalRow = { id: string; content?: string };
  h.s().saveJournalEntry('motivated', 'Echo journal first');
  await until(() => h.s().getTodayJournalEntry()?.content === 'Echo journal first', 'T37: entry in state');
  const jid = h.s().getTodayJournalEntry()!.id;
  const jrow = () => rows('journal_entries').find((r: JournalRow) => r.id === jid) as JournalRow | undefined;
  await until(() => jrow()?.content === 'Echo journal first', 'T37: entry row saved', 5000);
  const echoFirst = structuredClone(jrow()!);
  await quiet(50);
  h.s().editJournalEntry(jid, 'happy', 'Echo journal edited');
  await until(() => jrow()?.content === 'Echo journal edited', 'T37: edit saved', 5000);
  await quiet(800);
  server.emit('journal_entries', echoFirst, 'UPDATE');
  await quiet(800);
  eq(h.s().getTodayJournalEntry()?.content, 'Echo journal edited', 'T37: a late echo of the first save leaves the edit');
  pass('T37 journal_entries late echo dropped');
});
