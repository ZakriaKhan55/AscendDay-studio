// Hook test (real useAppState + in-process fake Supabase, see harness/): marking several notices read
// where one save fails puts only that notice back to unread (CodeRabbit CR-04-11, 2026-11-14). Each
// notice is saved on its own, so the one the server took stays read here too.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { bootHook, story, until, quiet, eq, pass, server, fake, UID } from './harness/bootHook';

const blobAt = 'Sun 2026-11-01 5:00 AM PKT (UTC+05:00)';

await story('notificationRevert.hook (mark read, partial failure)', async () => {
  server.blob.set(UID, { state: { username: 'hooktester', lastSeenRelease: 100 }, updated_at: blobAt });
  // eslint-disable-next-line no-restricted-syntax -- notices from the last minutes, inside the 30-day window
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const notice = (id: string, min: number) => ({
    id, recipient_id: UID, actor_id: null, type: 'partner_nudge', title: `T ${id}`, message: `M ${id}`, payload: {}, read: false, created_at: ago(min),
  });
  const OK = 'd1000000-0000-4000-8000-000000000001';
  const BAD = 'd2000000-0000-4000-8000-000000000002';
  const tbl = () => server.g('notifications') as any[];
  tbl().push(notice(OK, 3), notice(BAD, 2));

  const h = await bootHook({ as: 'signedIn' });
  await until(h.loaded, 'signed-in boot loaded');
  const n = (id: string) => (h.s().state.notifications || []).find((x) => x.id === id);
  const row = (id: string) => tbl().find((r) => r.id === id);
  await until(() => !!n(OK) && !!n(BAD) && h.s().notificationsStatus === 'ready', 'inbox loaded');
  await quiet(1000);

  // BAD's save waits; OK's goes through; then BAD's is refused.
  const held = fake.hold((r) => r.method === 'PATCH' && r.table === 'notifications' && r.search.includes(BAD));
  const toastsBefore = h.toasts.length;
  h.s().markNotificationsRead([OK, BAD]);
  await until(() => n(OK)?.read === true && n(BAD)?.read === true, 'both read at once');
  await until(() => row(OK)?.read === true, 'OK saved on the server', 5000);
  await until(() => held.hits > 0, "BAD's save is on its way");
  fake.fail('notifications', 500, ['PATCH']);
  held.release();
  await until(() => h.toasts.length > toastsBefore, 'the failed save shows a toast');
  await until(() => n(BAD)?.read === false, 'BAD goes back to unread', 5000);
  eq(n(OK)?.read, true, 'OK stays read: its save worked');
  eq(row(BAD)?.read, false, 'the refused row stays unread');
  fake.unfail('notifications');
  pass('CR-04-11 a partial mark-read failure restores only the failed notice');
});
