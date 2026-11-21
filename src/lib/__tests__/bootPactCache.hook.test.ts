// Hook test (real useAppState + in-process fake Supabase, see harness/): a load over a dirty device
// cache (ascend_dirty_<uid> set: the last save never finished) shows pacts and partnerships as the
// server holds them from its first render, not the cached copies until the partner refresh
// (knowledge/mode-a-shared-challenge-flash-2026-11-21.md, fix A).
//   B1 boot: the server relinked my goal, the partner ticked today, a pact was deleted and a
//      partnership ended; the cache holds the old copies. The first render with server data shows the
//      new goal and the tick, no deleted pact, no ended partnership.
//   B2 sign-in with the partnership and challenge reads failing (offline-like): the cached pacts and
//      partnership are still shown.
//   B3 background load (pull after a failed load) while my pact tick is still being saved: the tick
//      on screen is kept; the rest of the partner data comes from the server.
// Mutation proof: without withHydratedPartnerData in store.ts, B1 fails (old goal, ghost pact, p0);
// with it but no in-flight hold-back (empty writingPactIds), B3 fails (the tick vanishes).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { bootHook, story, until, eq, assert, pass, server, fake, UID } from './harness/bootHook';

const blobAt = 'Sun 2026-11-01 5:00 AM PKT (UTC+05:00)';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const OLD_PAL = '33333333-3333-4333-8333-333333333333';
const PS1 = '88888888-8888-4888-8888-888888888888';
const PS0 = '99999999-9999-4999-8999-999999999999';
const PACT = '55555555-5555-4555-8555-555555555555';
const GHOST = '66666666-6666-4666-8666-666666666666';

const tbl = (t: string) => server.g(t) as any[];
let partnershipsDown = false;
const base = globalThis.fetch;
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
(globalThis as any).fetch = async (input: any, init?: any) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url);
  if (req.method === 'GET' && url.searchParams.has('or')) {
    if (url.pathname === '/rest/v1/partnerships') {
      if (partnershipsDown) return answer({ message: 'down' }, 500);
      return answer(tbl('partnerships').filter((r) => r.user1_id === UID || r.user2_id === UID));
    }
    if (url.pathname === '/rest/v1/partner_invites') return answer([]);
  }
  return base(req);
};

await story('bootPactCache.hook (dirty boot shows server pacts first)', async () => {
  const { DEFAULT_STATE } = await import('@/types');
  const { todayKey, addDays } = await import('../time/dates');
  const today = todayKey();
  const start = addDays(today, -2);
  // eslint-disable-next-line no-restricted-syntax -- created two days ago, so it is running today
  const createdAt = new Date(Date.now() - 2 * 86400000).toISOString();

  server.blob.set(UID, { state: { username: 'hooktester', lastSeenRelease: 100 }, updated_at: blobAt });
  tbl('profiles').push({ id: PARTNER, uid: '222222', username: 'hookpartner', avatar: '🦊', stats: {}, is_profile_public: true, accept_partner_invites: true });
  tbl('partnerships').push({ id: PS1, user1_id: UID, user1_username: 'hooktester', user2_id: PARTNER, user2_username: 'hookpartner', paired_at: blobAt });
  // Server: my side relinked to Walk, partner ticked today. GHOST was deleted, PS0 ended.
  tbl('shared_challenges').push({
    id: PACT, partnership_id: PS1, title: 'Daily pact', target_habit_name: 'Walk', duration_days: 7, joint_streak: 0,
    total_joint_days_completed: 0, user1_category: 'habit', user1_target: 'Walk', user2_category: 'habit', user2_target: 'Run',
    user1_done_dates: [], user2_done_dates: [start, today], status: 'active', created_at: createdAt, start_date: start,
  });

  const cachedPact = (id: string, title: string, mine: string) => ({
    id, partnershipId: PS1, title, targetHabitName: mine, durationDays: 7, jointStreak: 0, user1Category: 'habit', user1Target: mine,
    user2Category: 'habit', user2Target: 'Run', user1DoneDates: [], user2DoneDates: [start], status: 'active', createdAt, startDate: start,
  });
  const live = { id: PS1, user1Id: UID, user1Username: 'hooktester', user2Id: PARTNER, user2Username: 'hookpartner', pairedAt: blobAt };
  const ended = { id: PS0, user1Id: UID, user1Username: 'hooktester', user2Id: OLD_PAL, user2Username: 'oldpal', pairedAt: blobAt };
  const cache = {
    ...DEFAULT_STATE,
    currentUser: { id: UID, uid: '424242', email: 'hook@test.local', username: 'hooktester', avatar: '🧑', createdAt: blobAt, isProfilePublic: true },
    username: 'hooktester',
    sharedChallenges: [cachedPact(PACT, 'Daily pact', 'Read'), cachedPact(GHOST, 'Deleted pact', 'Swim')],
    partnerships: [live, ended],
    partnership: ended,
  };
  const cacheKey = `ascend_user_cache_${UID}`;
  const dirtyKey = `ascend_dirty_${UID}`;

  // The first render that carries server data (isServerDataApplied turns true), before any refresh.
  let first: any = null;
  let wasApplied = false;
  const record = (store: any) => {
    const applied = Boolean(store.isServerDataApplied && store.state.currentUser?.id === UID);
    if (applied && !wasApplied && !first) {
      first = {
        pacts: store.state.sharedChallenges.map((c: any) => ({ id: c.id, mine: c.user1Target, partner: c.user2DoneDates, done: c.user1DoneDates })),
        partnerships: store.state.partnerships.map((p: any) => p.id),
        partnership: store.state.partnership?.id ?? null,
      };
    }
    wasApplied = applied;
  };

  // B1
  const h = await bootHook({ as: 'signedIn', storage: { [cacheKey]: cache, [dirtyKey]: 'seed-1' }, use: record });
  await until(h.loaded, 'B1: boot loaded');
  await until(() => first, 'B1: first render with server data');
  eq(first.pacts, [{ id: PACT, mine: 'Walk', partner: [start, today], done: [] }], 'B1: server goal and partner tick, no deleted pact');
  eq(first.partnerships, [PS1], 'B1: ended partnership not shown');
  eq(first.partnership, PS1, 'B1: partnership is the live one');
  pass('B1 dirty boot: first render shows the server pacts and partnerships');

  // B2: sign out, the dirty cache back on the device, the partner reads fail on sign-in.
  await until(() => (fake.inFlight.get('user_data') ?? 0) === 0, 'B2: boot saves settled');
  await h.supabase.auth.signOut();
  await until(() => h.s().state.currentUser === null, 'B2: signed out');
  h.storage.setItem(cacheKey, JSON.stringify(cache));
  h.storage.setItem(dirtyKey, 'seed-2');
  partnershipsDown = true;
  fake.fail('shared_challenges', 500, ['GET']);
  first = null;
  wasApplied = false;
  await h.signIn();
  await until(h.loaded, 'B2: sign-in loaded');
  await until(() => first, 'B2: first render with server data');
  eq(
    first.pacts.map((p: any) => p.id).sort(),
    [PACT, GHOST].sort(),
    'B2: cached pacts shown when the partner reads failed'
  );
  assert(first.pacts.find((p: any) => p.id === PACT)?.mine === 'Read', 'B2: the cached copy (nothing newer could be read)');
  eq(first.partnership, PS0, 'B2: cached partnership kept when its read failed');
  pass('B2 dirty sign-in with partner reads failing: cached pacts and partnerships stay');

  // B3: the sign-in load fails (opened from the copy); a pact tick is sent and held; the load that
  // runs on pull-to-refresh (a background load) reads the row before the tick: the tick stays.
  partnershipsDown = false;
  fake.unfail('shared_challenges');
  await until(() => (fake.inFlight.get('user_data') ?? 0) === 0, 'B3: saves settled');
  await h.supabase.auth.signOut();
  await until(() => h.s().state.currentUser === null, 'B3: signed out');
  h.storage.setItem(cacheKey, JSON.stringify(cache));
  h.storage.setItem(dirtyKey, 'seed-3');
  const profiles = server.g('profiles') as any[];
  const own = profiles.splice(profiles.findIndex((p) => p.id === UID), 1);
  fake.fail('profiles', 500, ['POST']);
  await h.signIn();
  await until(() => h.s().state.currentUser?.id === UID && !h.s().isSessionLoading, 'B3: opened from the device copy');
  assert(!h.s().isServerDataApplied, 'B3: copy, not server data');
  const held = fake.hold((r) => r.table === 'rpc/save_shared_challenge_atomic');
  const mine = () => h.s().state.sharedChallenges.find((c) => c.id === PACT)?.user1DoneDates || [];
  void h.s().logSharedChallengeHabit(PACT);
  await until(() => mine().includes(today), 'B3: ticked on screen');
  await until(() => held.hits > 0, 'B3: tick save on its way');
  assert(h.storage.getItem(dirtyKey), 'B3: device copy marked dirty');
  profiles.push(...own);
  fake.unfail('profiles');
  first = null;
  wasApplied = false;
  await h.s().refreshNow();
  await until(() => first, 'B3: first render with server data', 10_000);
  const kept = first.pacts.find((p: any) => p.id === PACT);
  assert(kept?.done.includes(today), `B3: the tick on screen is kept (got ${JSON.stringify(kept?.done)})`);
  assert(!tbl('shared_challenges').find((r) => r.id === PACT).user1_done_dates.includes(today), 'B3: the server row has no tick yet');
  eq(first.pacts.map((p: any) => p.id), [PACT], 'B3: deleted pact gone (no write on it)');
  eq(first.partnership, PS1, 'B3: ended partnership gone');
  held.release();
  await until(() => tbl('shared_challenges').find((r) => r.id === PACT).user1_done_dates.includes(today), 'B3: tick reached the server', 5000);
  await until(() => mine().includes(today), 'B3: tick still on screen after the save');
  pass('B3 background load with a pact write in flight keeps the tick on screen');
}, 60_000);
