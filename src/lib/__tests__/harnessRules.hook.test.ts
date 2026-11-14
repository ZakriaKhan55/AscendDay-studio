// Self-test of the hook-test harness (harness/fakeServer.ts, harness/fakeSupabase.ts): the fake
// database must refuse what the live one refuses, or a hook test can pass on a write the server drops.
//   H1  a PATCH that moves a workout into the future is refused as a whole (23514), like the upsert
//       (workouts_guard_future is BEFORE INSERT OR UPDATE).
//   H2  a PATCH that moves today's reading log to yesterday is dropped (reading_logs_guard_today is
//       BEFORE INSERT OR UPDATE); a soft delete of it still goes through.
//   H3  a socket closed before its open timer ran stays closed: no onopen, no realtime subscriber.
//   H4  a PATCH on a server-owned table (point_entries, league_archives) changes nothing, a soft
//       delete included (their *_guard_server_owned triggers are BEFORE INSERT OR UPDATE, RETURN NULL).
import { story, assert, eq, pass, server, sockets, UID } from './harness/bootHook';
import { FakeSocket, REF } from './harness/fakeSupabase';

const DAY = 24 * 3600 * 1000;
/** A day key `days` away from the account's today (noon UTC keeps the date stable). */
const dayFrom = (today: string, days: number) => new Date(Date.parse(`${today}T12:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
// eslint-disable-next-line no-restricted-syntax -- row timestamps for the fake database
const stampIn = (ms: number) => new Date(Date.now() + ms).toISOString();

await story('harnessRules.hook (fake database and socket rules)', async () => {
  const today = server.accountToday();

  // H1
  server.upsert('workouts', [{ id: 'h-w1', user_id: UID, data: { id: 'h-w1', date: today }, updated_at: stampIn(0) }], 'seed');
  const refused = server.update('workouts', UID, ['h-w1'], { data: { id: 'h-w1', date: dayFrom(today, 1) }, updated_at: stampIn(1000) }, 'test');
  eq(refused.status, 400, 'H1: a PATCH dating a workout tomorrow is refused');
  eq(server.row('workouts', UID, 'h-w1')?.data?.date, today, 'H1: the stored workout keeps its date');
  const allowed = server.update('workouts', UID, ['h-w1'], { data: { id: 'h-w1', date: today, type: 'Run' }, updated_at: stampIn(2000) }, 'test');
  eq([allowed.status, server.row('workouts', UID, 'h-w1')?.data?.type], [204, 'Run'], 'H1: a PATCH on today still saves');
  pass('H1 PATCH meets the future-date guard');

  // H2
  server.upsert('reading_logs', [{ id: 'h-r1', user_id: UID, data: { id: 'h-r1', date: today }, updated_at: stampIn(0) }], 'seed');
  server.update('reading_logs', UID, ['h-r1'], { data: { id: 'h-r1', date: dayFrom(today, -1) }, updated_at: stampIn(1000) }, 'test');
  eq(server.row('reading_logs', UID, 'h-r1')?.data?.date, today, "H2: a PATCH moving today's reading log to yesterday is dropped");
  server.update('reading_logs', UID, ['h-r1'], { deleted_at: stampIn(2000), updated_at: stampIn(2000) }, 'test');
  assert(Boolean(server.row('reading_logs', UID, 'h-r1')?.deleted_at), 'H2: its soft delete still goes through');
  pass('H2 PATCH meets the reading/skill guard_today');

  // H3
  const subscribersBefore = server.subscribers.size;
  const socket = new FakeSocket(`wss://${REF}.supabase.co/realtime/v1/websocket`);
  let opened = false;
  socket.onopen = () => (opened = true);
  socket.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  eq(socket.readyState, FakeSocket.CLOSED, 'H3: the socket stays closed');
  assert(!opened, 'H3: no onopen after close()');
  eq(server.subscribers.size, subscribersBefore, 'H3: no realtime subscriber left behind');
  assert(!sockets.has(socket), 'H3: not listed as an open socket');
  pass('H3 a socket closed before it opened never opens');

  // H4 (rows seeded directly: the server writes these tables, the app never can)
  for (const table of ['point_entries', 'league_archives']) {
    const id = `h-${table}`;
    const at = stampIn(-60_000);
    server.t(table).set(`${UID}:${id}`, { user_id: UID, id, data: { id, amount: 5 }, created_at: at, updated_at: at, deleted_at: null, server_updated_at: server.stamp() });
    const edit = server.update(table, UID, [id], { data: { id, amount: 500 }, updated_at: stampIn(1000) }, 'test');
    server.update(table, UID, [id], { deleted_at: stampIn(2000), updated_at: stampIn(2000) }, 'test');
    const row = server.row(table, UID, id);
    eq([edit.status, row?.data?.amount, row?.deleted_at, row?.updated_at], [204, 5, null, at], `H4: a PATCH on ${table} changes nothing`);
  }
  pass('H4 PATCH meets the server-owned table guards');
});
