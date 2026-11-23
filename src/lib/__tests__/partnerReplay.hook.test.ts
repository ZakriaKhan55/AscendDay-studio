// Hook test (real useAppState + in-process fake Supabase, see harness/): realtime partner changes that
// reach the screen while an account load waits to apply are kept by the load (replayed in order onto
// its older partner read), so the screen never shows the read's older copy, not even for one render
// (deferred finding "partner flash during an account load"; src/lib/partners/partnerEvents.ts).
// Each case opens the account from the device copy (its sign-in load fails), then pull-to-refresh
// runs a background load whose read lands and waits on the held season-config read.
//   R1 clean load: my partner ticks today (pact UPDATE) while the load waits; every render after the
//      tick shows it, and no partner refetch is needed for it.
//   R2 dirty (R2a) and clean (R2b) load: an invite, a partnership (with its pact) and a pact are deleted while the load
//      waits (the refetch those events start is held): they never come back on screen.
//   R3 an event applied before the load's read started is not replayed over the newer read.
//   R4 a newer full partner read applied while the load waits wins as before (its pacts stay).
//   R5 an invite added while the load waits (an event that only asks for a refetch): the partner
//      data is fetched again after the load.
// Account switch / sign-out clearing the log is covered in partnerEvents.test.ts (a later load of
// any account starts its read after every event of the session before, so it is not observable here).
// Mutation proof: on the old code (no replay) R1 and R2 fail (the load renders the older pact, the
// deleted invite/partnership/pact come back until the refetch). Replay ignoring the seq (since(…, 0))
// fails R3. Replay over the newer live read with the full-read prune removed fails R4. Without the
// partnerRefetchEvent check R5 fails (no refetch).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { bootHook, story, until, eq, assert, pass, server, fake, UID, quiet } from './harness/bootHook';

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
let partnershipReads = 0;
let inviteReads = 0;
let liveInFlight = 0;
// Armed: the next invites read (the first read of a live partner sync run) waits for the gate, so
// that run, and every partner refresh asked for meanwhile (they join it), cannot land before the load.
let holdNextInvites: Promise<void> | null = null;
let invitesDown = false;
const base = globalThis.fetch;
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
(globalThis as any).fetch = async (input: any, init?: any) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url);
  if (req.method === 'GET' && url.searchParams.has('or')) {
    const read = async (rows: () => any[], partnerships: boolean) => {
      liveInFlight++;
      try {
        if (partnerships) partnershipReads++;
        else inviteReads++;
        if (!partnerships && holdNextInvites) {
          const gate = holdNextInvites;
          holdNextInvites = null;
          await gate;
        }
        if (!partnerships && invitesDown) return answer({ message: 'down' }, 500);
        return answer(rows());
      } finally {
        liveInFlight--;
      }
    };
    if (url.pathname === '/rest/v1/partnerships') return read(() => tbl('partnerships').filter((r) => r.user1_id === UID || r.user2_id === UID), true);
    if (url.pathname === '/rest/v1/partner_invites') return read(() => tbl('partner_invites').filter((r) => r.to_user_id === UID || r.from_user_id === UID), false);
  }
  return base(req);
};

await story('partnerReplay.hook (partner events while a load waits are kept)', async () => {
  const { DEFAULT_STATE } = await import('@/types');
  const { todayKey, addDays } = await import('../time/dates');
  const today = todayKey();
  const start = addDays(today, -2);
  // eslint-disable-next-line no-restricted-syntax -- created two days ago, so it is running today
  const createdAt = new Date(Date.now() - 2 * 86400000).toISOString();

  server.blob.set(UID, { state: { username: 'hooktester', lastSeenRelease: 100 }, updated_at: blobAt });
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
  const seed = () => {
    tbl('partnerships').splice(0, Infinity, psRow(PS1, PARTNER, 'hookpartner'), psRow(PS2, PAL2, 'hookpal'));
    tbl('shared_challenges').splice(0, Infinity, pactRow(PACT, PS1, 'Daily pact'), pactRow(PACT2, PS2, 'Pal pact'), pactRow(PACT3, PS1, 'Second pact'));
    tbl('partner_invites').splice(0, Infinity, inviteRow(INV));
  };
  seed();
  const row = (id: string) => tbl('shared_challenges').find((r) => r.id === id);
  const emit = (table: string, r: any, type: string) => server.emit(table, r, type);

  const user = { id: UID, uid: '424242', email: 'hook@test.local', username: 'hooktester', avatar: '🧑', createdAt: blobAt, isProfilePublic: true };
  const cache = { ...DEFAULT_STATE, currentUser: user, username: 'hooktester' };
  const cacheKey = `ascend_user_cache_${UID}`;
  const dirtyKey = `ascend_dirty_${UID}`;

  let watch: ((store: any) => void) | null = null;
  const h = await bootHook({ as: 'signedIn', storage: { [cacheKey]: cache }, use: (store: any) => watch?.(store) });
  await until(h.loaded, 'boot loaded');
  const screen = () => h.s().state;
  const pact = (id: string) => (screen().sharedChallenges || []).find((c: any) => c.id === id);

  /** Signs out, opens the account from the device copy, waits for the live partner sync to settle. */
  const openFromCopy = async (label: string, dirty: boolean) => {
    await until(() => (fake.inFlight.get('user_data') ?? 0) === 0, `${label}: saves settled`);
    await h.supabase.auth.signOut();
    await until(() => screen().currentUser === null, `${label}: signed out`);
    seed();
    h.storage.setItem(cacheKey, JSON.stringify(cache));
    if (dirty) h.storage.setItem(dirtyKey, `seed-${label}`);
    else h.storage.removeItem(dirtyKey);
    const own = profiles.splice(profiles.findIndex((p) => p.id === UID), 1);
    fake.fail('profiles', 500, ['POST']);
    await h.signIn();
    await until(() => screen().currentUser?.id === UID && !h.s().isSessionLoading, `${label}: opened from the device copy`);
    assert(!h.s().isServerDataApplied, `${label}: copy, not server data`);
    profiles.push(...own);
    fake.unfail('profiles');
    await until(() => h.s().partnersStatus === 'ready' && pact(PACT), `${label}: live partner sync shows the pacts`);
    await until(() => liveInFlight === 0 && (fake.inFlight.get('shared_challenges') ?? 0) === 0, `${label}: partner reads settled`);
    await quiet(300);
  };
  /**
   * Pull-to-refresh: a background load whose read is done and waits to apply. `holdLive`: a live
   * partner sync run started just before is held (pull-to-refresh's own partner refresh and the
   * refetches realtime events ask for join it), so no full partner read lands while the load waits.
   */
  const loadWaiting = async (label: string, holdLive: boolean) => {
    let releaseLive = () => {};
    if (holdLive) {
      holdNextInvites = new Promise<void>((resolve) => (releaseLive = resolve));
      void h.s().refreshPartners();
      await until(() => !holdNextInvites, `${label}: live partner sync held`);
    }
    const afterRead = fake.hold((r) => r.table === 'rpc/ascend_season_config');
    const refreshing = h.s().refreshNow();
    await until(() => afterRead.hits > 0, `${label}: load read done, waiting to apply`);
    assert(!h.s().isServerDataApplied, `${label}: the load has not applied yet`);
    return { release: () => afterRead.release(), releaseLive, refreshing };
  };

  // R1
  await openFromCopy('R1', false);
  const r1 = await loadWaiting('R1', true);
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
  await until(() => seen1, 'R1: partner tick on screen from the event');
  const reads1 = partnershipReads;
  r1.release();
  await until(() => h.s().isServerDataApplied, 'R1: load applied', 10_000);
  await quiet(600);
  eq(flash1, [], 'R1: no render after the tick shows the older pact');
  assert(pact(PACT)?.user2DoneDates?.includes(today), 'R1: the tick is on screen after the load');
  eq(partnershipReads, reads1, 'R1: no partner read ran while the load applied');
  r1.releaseLive();
  await r1.refreshing;
  await until(() => liveInFlight === 0 && (fake.inFlight.get('shared_challenges') ?? 0) === 0, 'R1: live sync done');
  watch = null;
  eq(flash1, [], 'R1: no older render after the live sync either');
  pass('R1 pact update while a clean load waits: kept, no older render');

  // R2 (both load paths: the dirty one takes pacts from withHydratedPartnerData, the clean one as read)
  const deletesWhileLoading = async (label: string, dirty: boolean) => {
    await openFromCopy(label, dirty);
    assert(screen().partnerInvites.some((i: any) => i.id === INV) && screen().partnerships.some((p: any) => p.id === PS2) && pact(PACT2) && pact(PACT3), `${label}: all on screen first`);
    const r2 = await loadWaiting(label, true);
    tbl('partner_invites').splice(0, Infinity);
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
    await until(() => seen2, `${label}: deletes on screen from the events`);
    r2.release();
    await until(() => h.s().isServerDataApplied, `${label}: load applied`, 10_000);
    await quiet(600);
    eq(back2, [], `${label}: nothing deleted comes back while the refetch is held`);
    r2.releaseLive();
    await r2.refreshing;
    await until(() => liveInFlight === 0 && (fake.inFlight.get('shared_challenges') ?? 0) === 0, `${label}: held refetch landed`);
    await quiet(500);
    watch = null;
    eq(back2, [], `${label}: nothing deleted comes back after the refetch`);
    pass(`${label} invite/partnership/pact deletes while a ${dirty ? 'dirty' : 'clean'} load waits stay deleted`);
  };
  await deletesWhileLoading('R2a', true);
  await deletesWhileLoading('R2b', false);

  // R3: my partner ticks (event applied), then unticks with that event lost; the load reads the untick.
  await openFromCopy('R3', false);
  Object.assign(row(PACT), { user2_done_dates: [start, today] });
  emit('shared_challenges', row(PACT), 'UPDATE');
  await until(() => pact(PACT)?.user2DoneDates?.includes(today), 'R3: tick on screen from the event');
  Object.assign(row(PACT), { user2_done_dates: [start] });
  const r3 = await loadWaiting('R3', true);
  r3.release();
  await until(() => h.s().isServerDataApplied, 'R3: load applied', 10_000);
  eq(pact(PACT)?.user2DoneDates, [start], 'R3: the event older than the read is not replayed over it');
  r3.releaseLive();
  await r3.refreshing;
  await until(() => liveInFlight === 0 && (fake.inFlight.get('shared_challenges') ?? 0) === 0, 'R3: live sync done');
  pass('R3 an event before the load read started is not replayed');

  // R4: an event while the load waits, then a newer full live read (my partner ticked twice since).
  await openFromCopy('R4', false);
  const r4 = await loadWaiting('R4', false);
  Object.assign(row(PACT), { title: 'Renamed pact' });
  emit('shared_challenges', row(PACT), 'UPDATE');
  await until(() => pact(PACT)?.title === 'Renamed pact', 'R4: rename on screen from the event');
  Object.assign(row(PACT), { user2_done_dates: [addDays(today, -1), today], title: 'Renamed again' });
  await h.s().refreshPartners();
  await until(() => pact(PACT)?.title === 'Renamed again', 'R4: newer live read on screen');
  const live4 = JSON.stringify(screen().sharedChallenges);
  r4.release();
  await until(() => h.s().isServerDataApplied, 'R4: load applied', 10_000);
  await r4.refreshing;
  eq(JSON.stringify(screen().sharedChallenges), live4, 'R4: the pacts of the newer live read stay as they were');
  pass('R4 a newer full live read applied while the load waits wins (unchanged)');

  // R5: every live partner read fails at the invites while the load waits (no full read lands); an
  // invite is added meanwhile (an event that only asks for a refetch). Once the load applies, the
  // partner data is fetched again (a run reads the invites first) and shows it.
  await openFromCopy('R5', false);
  invitesDown = true;
  const r5 = await loadWaiting('R5', false);
  tbl('partner_invites').push(inviteRow(INV2));
  const invites5 = inviteReads;
  emit('partner_invites', inviteRow(INV2), 'INSERT');
  await until(() => inviteReads > invites5, 'R5: the event asked for a refetch');
  await until(() => liveInFlight === 0 && (fake.inFlight.get('shared_challenges') ?? 0) === 0, 'R5: failed live reads settled');
  await quiet(300);
  invitesDown = false;
  const beforeLoad5 = inviteReads;
  r5.release();
  await until(() => h.s().isServerDataApplied, 'R5: load applied', 10_000);
  await r5.refreshing;
  await until(() => inviteReads > beforeLoad5, 'R5: partner data fetched again after the load', 5000);
  await until(() => screen().partnerInvites.some((i: any) => i.id === INV2), 'R5: new invite on screen', 5000);
  pass('R5 an invite added while the load waits: partner data fetched again after the load');
}, 90_000);
