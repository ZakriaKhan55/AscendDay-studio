// Hook test (real useAppState + in-process fake Supabase, see harness/): a live partner refresh whose
// reads started before a realtime partner change, and that return data older than it, keeps that change
// on screen (the logged events newer than the read are replayed onto the read data before it is
// applied, as an account load does: partnerReplay.hook.test.ts, src/lib/partners/partnerEvents.ts).
// The pacts read of a refresh is answered as the server stood when it was asked and held until the
// test releases it, so the change lands between the read's snapshot and its apply.
//   L1 my partner ticks today (pact UPDATE) while a refresh's read is held: every render after the
//      tick shows it, also after the refresh applies (no later event or refresh brings it back).
//   L2 an invite, a partnership (with its pact) and a pact are deleted while a refresh's read is
//      held: they never come back on screen.
//   L3 an event applied before the refresh's read started is not replayed over the newer read.
//   L4 two refreshes asked for while the first one's read is held (an older and a newer read): the
//      older never overwrites the newer (they never overlap: singleFlight).
//   L5 an invite added while a refresh's read is held (an event that only asks for a refetch): the
//      partner data is read again after the refresh and shows it.
//   L6 more changes than the bounded log keeps arrive while a refresh's read is held (a gap): the
//      partner data is read again after the refresh and shows the latest.
// Mutation proof (each run on the code named): the old code (no replay in the live refresh) fails L1
// (the refresh renders the older pact read and nothing brings the tick back) and L6 (no read again
// after a gap); L2-L5 pass on it (L2: deleted ids are tombstoned and every read filters them; L3-L5
// guard what stays). The live replay passed no events fails L1. Replay ignoring the seq (since(…, 0))
// fails L3. Without singleFlight around the live refresh L4 fails. Without the refetch a non-delete
// invite event asks for L5 fails. Without the gap refetch L6 fails. Without the read's tombstone
// filters L2 still passes (the replay removes them again); without both those filters and the replay
// L2 fails (the held read's apply brings them back).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { bootHook, story, until, eq, assert, pass, server, fake, UID, quiet, joinedTopics } from './harness/bootHook';

const blobAt = 'Sun 2026-11-01 5:00 AM PKT (UTC+05:00)';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const PAL2 = '33333333-3333-4333-8333-333333333333';
const STRANGER = '44444444-4444-4444-8444-444444444444';
const PS1 = '88888888-8888-4888-8888-888888888888';
const PS2 = '99999999-9999-4999-8999-999999999999';
const PACT = '55555555-5555-4555-8555-555555555555';
const PACT2 = '66666666-6666-4666-8666-666666666666';
const PACT3 = '77777777-7777-4777-8777-777777777777';
const INV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INV2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const tbl = (t: string) => server.g(t) as any[];
const PARTNER_TABLES = new Set(['partnerships', 'partner_invites', 'shared_challenges']);
const reads = { partnerships: 0, partner_invites: 0, shared_challenges: 0 } as Record<string, number>;
let liveInFlight = 0;
// Armed per table: the next read of it is answered as the server stands now, then held until released.
type Snapshot = { hit: boolean; gate: Promise<void>; release: () => void };
const snapshots = new Map<string, Snapshot>();
const holdNextRead = (table: string): Snapshot => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const snap: Snapshot = { hit: false, gate, release: () => release() };
  snapshots.set(table, snap);
  return snap;
};
const base = globalThis.fetch;
(globalThis as any).fetch = async (input: any, init?: any) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url);
  const table = url.pathname.startsWith('/rest/v1/') ? url.pathname.slice('/rest/v1/'.length) : '';
  if (req.method !== 'GET' || !PARTNER_TABLES.has(table)) return base(req);
  liveInFlight++;
  try {
    reads[table]++;
    const snap = snapshots.get(table);
    if (snap) snapshots.delete(table);
    // The fake answers no `or` filter (partnerships and invites of this account): answered here.
    const res = url.searchParams.has('or')
      ? new Response(
          JSON.stringify(
            tbl(table).filter((r) => (table === 'partnerships' ? r.user1_id === UID || r.user2_id === UID : r.to_user_id === UID || r.from_user_id === UID))
          ),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      : await base(req);
    if (!snap) return res;
    const body = await res.text();
    snap.hit = true;
    await snap.gate;
    return new Response(body, { status: res.status, headers: res.headers });
  } finally {
    liveInFlight--;
  }
};

await story('partnerLiveReplay.hook (partner events while a live refresh reads are kept)', async () => {
  const { todayKey, addDays } = await import('../time/dates');
  const today = todayKey();
  const start = addDays(today, -2);
  // eslint-disable-next-line no-restricted-syntax -- created two days ago, so it is running today
  const createdAt = new Date(Date.now() - 2 * 86400000).toISOString();

  const profiles = server.g('profiles') as any[];
  profiles.push(
    { id: PARTNER, uid: '222222', username: 'hookpartner', avatar: '🦊', stats: {}, is_profile_public: true, accept_partner_invites: true },
    { id: PAL2, uid: '333333', username: 'hookpal', avatar: '🐻', stats: {}, is_profile_public: true, accept_partner_invites: true },
    { id: STRANGER, uid: '444444', username: 'stranger', avatar: '🐸', stats: {}, is_profile_public: true, accept_partner_invites: true }
  );
  const psRow = (id: string, other: string, name: string) => ({ id, user1_id: UID, user1_username: 'hooktester', user2_id: other, user2_username: name, paired_at: blobAt });
  const pactRow = (id: string, partnershipId: string, title: string) => ({
    id, partnership_id: partnershipId, title, target_habit_name: 'Walk', duration_days: 7, joint_streak: 0,
    total_joint_days_completed: 0, user1_category: 'habit', user1_target: 'Walk', user2_category: 'habit', user2_target: 'Run',
    user1_done_dates: [], user2_done_dates: [start], status: 'active', created_at: createdAt, start_date: start,
  });
  const inviteRow = (id: string) => ({
    id, from_user_id: STRANGER, from_username: 'stranger', from_avatar: '🐸', to_user_id: UID, to_username: 'hooktester', status: 'pending', created_at: blobAt,
  });
  tbl('partnerships').push(psRow(PS1, PARTNER, 'hookpartner'), psRow(PS2, PAL2, 'hookpal'));
  tbl('shared_challenges').push(pactRow(PACT, PS1, 'Daily pact'), pactRow(PACT2, PS2, 'Pal pact'), pactRow(PACT3, PS1, 'Second pact'));
  tbl('partner_invites').push(inviteRow(INV));
  const row = (id: string) => tbl('shared_challenges').find((r) => r.id === id);
  const emit = (table: string, r: any, type: string) => server.emit(table, r, type);

  let watch: ((store: any) => void) | null = null;
  const h = await bootHook({ as: 'signedIn', use: (store: any) => watch?.(store) });
  await until(h.loaded, 'boot loaded');
  const screen = () => h.s().state;
  const pact = (id: string) => (screen().sharedChallenges || []).find((c: any) => c.id === id);
  await until(() => joinedTopics().some((t) => t.includes(`social_realtime_${UID}`)), 'partner channel joined');
  await until(() => h.s().partnersStatus === 'ready' && pact(PACT) && pact(PACT2) && pact(PACT3), 'live partner sync shows the pacts');
  const settled = (label: string) => until(() => liveInFlight === 0 && (fake.inFlight.get('shared_challenges') ?? 0) === 0, `${label}: partner reads settled`);
  await settled('boot');
  // The session's once-per-partnership stale-invite cleanup ran at boot (the fake applies its delete
  // to every invite): the invite is put back and read in again.
  if (!tbl('partner_invites').some((r) => r.id === INV)) tbl('partner_invites').push(inviteRow(INV));
  await h.s().refreshPartners();
  await until(() => screen().partnerInvites.some((i: any) => i.id === INV), 'invite on screen');
  await settled('boot');
  await quiet(300);

  /** A live partner refresh whose pacts read is answered now and held until released. */
  const refreshHeld = async (label: string) => {
    const snap = holdNextRead('shared_challenges');
    const running = h.s().refreshPartners();
    await until(() => snap.hit, `${label}: refresh read done, held`);
    return { release: snap.release, running };
  };

  // L1
  const l1 = await refreshHeld('L1');
  Object.assign(row(PACT), { user2_done_dates: [start, today] });
  let seen1 = false;
  const flash1: string[][] = [];
  watch = (store: any) => {
    if (store.state.currentUser?.id !== UID) return;
    const dates = (store.state.sharedChallenges || []).find((c: any) => c.id === PACT)?.user2DoneDates || [];
    if (dates.includes(today)) seen1 = true;
    else if (seen1) flash1.push(dates);
  };
  emit('shared_challenges', row(PACT), 'UPDATE');
  await until(() => seen1, 'L1: partner tick on screen from the event');
  l1.release();
  await l1.running;
  await settled('L1');
  await quiet(500);
  watch = null;
  eq(flash1, [], 'L1: no render after the tick shows the older pact read');
  assert(pact(PACT)?.user2DoneDates?.includes(today), 'L1: the tick is on screen after the refresh');
  pass('L1 pact update while a live refresh reads: kept on every render');

  // L3: my partner renames the pact (event applied), then renames it again with that event lost; the
  // refresh reads the second name.
  Object.assign(row(PACT), { title: 'L3 event' });
  emit('shared_challenges', row(PACT), 'UPDATE');
  await until(() => pact(PACT)?.title === 'L3 event', 'L3: rename on screen from the event');
  Object.assign(row(PACT), { title: 'L3 read' });
  await h.s().refreshPartners();
  await settled('L3');
  await until(() => pact(PACT)?.title === 'L3 read', 'L3: the event older than the read is not replayed over it', 3000);
  await quiet(300);
  eq(pact(PACT)?.title, 'L3 read', 'L3: the read stays on screen');
  pass('L3 an event before the refresh read started is not replayed');

  // L4: the first refresh reads the old title and is held; the title changes (no event) and a second
  // refresh is asked for: it reads the new title. The old read never lands after the new one.
  Object.assign(row(PACT), { title: 'L4 old' });
  const l4 = await refreshHeld('L4');
  Object.assign(row(PACT), { title: 'L4 new' });
  let seen4 = false;
  const flash4: string[] = [];
  watch = (store: any) => {
    if (store.state.currentUser?.id !== UID) return;
    const title = (store.state.sharedChallenges || []).find((c: any) => c.id === PACT)?.title;
    if (title === 'L4 new') seen4 = true;
    else if (seen4) flash4.push(title);
  };
  const pactReads4 = reads.shared_challenges;
  const second = h.s().refreshPartners();
  await quiet(400);
  l4.release();
  await Promise.all([l4.running, second]);
  await settled('L4');
  await quiet(300);
  watch = null;
  assert(reads.shared_challenges > pactReads4, 'L4: the second refresh read the pacts');
  eq(flash4, [], 'L4: the older read never overwrote the newer one');
  eq(pact(PACT)?.title, 'L4 new', 'L4: the newer read is on screen');
  pass('L4 two refreshes finishing in turn: the older read never overwrites the newer');

  // L5
  const l5 = await refreshHeld('L5');
  tbl('partner_invites').push(inviteRow(INV2));
  const invites5 = reads.partner_invites;
  emit('partner_invites', inviteRow(INV2), 'INSERT');
  await quiet(300);
  eq(reads.partner_invites, invites5, 'L5: no second read while the first runs');
  l5.release();
  await l5.running;
  await settled('L5');
  assert(reads.partner_invites > invites5, 'L5: the partner data was read again after the refresh');
  await until(() => screen().partnerInvites.some((i: any) => i.id === INV2), 'L5: new invite on screen', 5000);
  pass('L5 an invite added while a refresh reads: partner data read again after it');

  // L6: 101 renames while the read is held: the bounded log (100) drops the oldest, so the refresh
  // cannot replay them and reads again.
  const l6 = await refreshHeld('L6');
  for (let i = 0; i <= 100; i++) {
    Object.assign(row(PACT), { title: `L6 ${i}` });
    emit('shared_challenges', row(PACT), 'UPDATE');
  }
  await until(() => pact(PACT)?.title === 'L6 100', 'L6: renames on screen from the events');
  const pactReads6 = reads.shared_challenges;
  l6.release();
  await l6.running;
  await settled('L6');
  assert(reads.shared_challenges > pactReads6, 'L6: the partner data was read again after a log gap');
  eq(pact(PACT)?.title, 'L6 100', 'L6: the latest pact is on screen');
  pass('L6 a gap in the log while a refresh reads: partner data read again');

  // L2 (last: the deleted ids stay tombstoned)
  assert(screen().partnerInvites.some((i: any) => i.id === INV) && screen().partnerships.some((p: any) => p.id === PS2) && pact(PACT2) && pact(PACT3), 'L2: all on screen first');
  const l2 = await refreshHeld('L2');
  tbl('partner_invites').splice(tbl('partner_invites').findIndex((r) => r.id === INV), 1);
  tbl('partnerships').splice(tbl('partnerships').findIndex((r) => r.id === PS2), 1);
  tbl('shared_challenges').splice(0, Infinity, ...tbl('shared_challenges').filter((r) => r.id === PACT));
  const gone = (st: any) => ({
    invite: !(st.partnerInvites || []).some((i: any) => i.id === INV),
    partnership: !(st.partnerships || []).some((p: any) => p.id === PS2) && st.partnership?.id !== PS2,
    pacts: !(st.sharedChallenges || []).some((c: any) => c.id === PACT2 || c.id === PACT3),
  });
  let seen2 = false;
  const back2: unknown[] = [];
  watch = (store: any) => {
    if (store.state.currentUser?.id !== UID) return;
    const g = gone(store.state);
    if (g.invite && g.partnership && g.pacts) seen2 = true;
    else if (seen2) back2.push(g);
  };
  emit('partner_invites', { id: INV }, 'DELETE');
  emit('partnerships', { id: PS2 }, 'DELETE');
  emit('shared_challenges', { id: PACT3 }, 'DELETE');
  await until(() => seen2, 'L2: deletes on screen from the events');
  // The refetch the invite and partnership events asked for is held too, so the held read's own
  // apply is rendered before anything newer could cover it.
  const refetch2 = holdNextRead('partner_invites');
  l2.release();
  await until(() => refetch2.hit, 'L2: the held read applied, the refetch after it started');
  await quiet(500);
  eq(back2, [], 'L2: nothing deleted comes back when the held read applies');
  refetch2.release();
  await l2.running;
  await settled('L2');
  await quiet(500);
  watch = null;
  eq(back2, [], 'L2: nothing deleted comes back after the refetch');
  assert(pact(PACT), 'L2: the pact left stays');
  pass('L2 invite/partnership/pact deletes while a refresh reads stay deleted');
}, 90_000);
