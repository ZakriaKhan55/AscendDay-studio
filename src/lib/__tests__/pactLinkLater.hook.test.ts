// Hook test (real useAppState + in-process fake Supabase, see harness/): link my side of a running
// challenge to a habit later (store.linkSharedChallengeSide -> rpc ascend_pact_link_side).
//   T40  linking my side to a habit already done today: the RPC gets only the pact id and my new goal;
//        my goal changes on screen and on the server, the partner's goal, title and past days stay;
//        today goes in ticked with a normal save (as at creation)
//   T41  a hand tick today + a habit not done today: refused with a message, nothing sent
//   T42  the server refuses (finished pact): my goal goes back on screen, the error reaches the form
//   T43  a name that links to nothing (unlink): saved, today's tick kept
// The fake has no ascend_pact_link_side, so this file answers it from FakeServer's table with the
// server's rule (the caller's own side only).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { bootHook, story, until, quiet, eq, assert, pass, server, UID, habit, seedServerHabits } from './harness/bootHook';

const blobAt = 'Sun 2026-11-01 5:00 AM PKT (UTC+05:00)';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const PS1 = '88888888-8888-4888-8888-888888888888';
const PACT = '55555555-5555-4555-8555-555555555555';
const PACT2 = '66666666-6666-4666-8666-666666666666';

const tbl = (t: string) => server.g(t) as any[];
const linkCalls: any[] = [];
let refuseNext = '';
const base = globalThis.fetch;
const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
(globalThis as any).fetch = async (input: any, init?: any) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url);
  if (url.pathname === '/rest/v1/rpc/ascend_pact_link_side') {
    const a = await req.clone().json();
    linkCalls.push(a);
    if (refuseNext) {
      const error = refuseNext;
      refuseNext = '';
      return answer({ success: false, error });
    }
    const row = tbl('shared_challenges').find((r) => r.id === a.p_challenge_id);
    // The signed-in account is user1 of PS1: only user1_target changes.
    row.user1_target = String(a.p_target).trim().replace(/\s+/g, ' ');
    return answer({ success: true, challenge: { ...row }, today: null });
  }
  if (req.method === 'GET' && url.searchParams.has('or')) {
    if (url.pathname === '/rest/v1/partnerships') return answer(tbl('partnerships').filter((r) => r.user1_id === UID || r.user2_id === UID));
    if (url.pathname === '/rest/v1/partner_invites') return answer([]);
  }
  return base(req);
};

await story('pactLinkLater.hook (link my side of a running challenge later)', async () => {
  const { todayKey, addDays } = await import('../time/dates');
  const today = todayKey();
  const start = addDays(today, -2);
  server.blob.set(UID, { state: { username: 'hooktester', lastSeenRelease: 100 }, updated_at: blobAt });
  tbl('profiles').push({ id: PARTNER, uid: '222222', username: 'hookpartner', avatar: '🦊', stats: {}, is_profile_public: true, accept_partner_invites: true });
  tbl('partnerships').push({ id: PS1, user1_id: UID, user1_username: 'hooktester', user2_id: PARTNER, user2_username: 'hookpartner', paired_at: blobAt });
  // eslint-disable-next-line no-restricted-syntax -- created two days ago, so it is running today
  const createdAt = new Date(Date.now() - 2 * 86400000).toISOString();
  const row = (id: string, title: string, mine: string, u1: string[]) => ({
    id, partnership_id: PS1, title, target_habit_name: mine, duration_days: 7, joint_streak: 0, total_joint_days_completed: 1,
    user1_category: 'habit', user1_target: mine, user2_category: 'habit', user2_target: 'Run', user1_done_dates: u1,
    user2_done_dates: [start], status: 'active', created_at: createdAt, start_date: start,
  });
  tbl('shared_challenges').push(row(PACT, 'Walk daily', 'Walk', [start]), row(PACT2, 'Read daily', 'Read', [start, today]));
  seedServerHabits(
    habit('h-walk', 'HookWalk', { completions: { [today]: { done: true } } }),
    habit('h-read', 'HookRead', { completions: {} })
  );

  const h = await bootHook({ as: 'signedIn' });
  await until(h.loaded, 'signed-in boot loaded');
  await until(() => h.s().partnersStatus === 'ready', 'partners loaded');
  await until(() => h.s().state.sharedChallenges.some((c) => c.id === PACT) && h.s().state.sharedChallenges.some((c) => c.id === PACT2), 'pacts on screen');
  await until(() => h.s().state.habits.some((x) => x.id === 'h-walk'), 'habits loaded');
  await quiet(1500);
  const pact = (id = PACT) => h.s().state.sharedChallenges.find((c) => c.id === id)!;
  const srv = (id = PACT) => tbl('shared_challenges').find((r) => r.id === id);

  // T40
  const r40 = await h.s().linkSharedChallengeSide(PACT, '  HookWalk ');
  eq(r40, { changed: true, tickedToday: true, todayTickFailed: false }, 'T40: linked, today ticked');
  eq(linkCalls.length, 1, 'T40: one link call');
  eq(linkCalls[0], { p_challenge_id: PACT, p_target: 'HookWalk' }, 'T40: the RPC gets only the pact and my new goal');
  await until(() => pact().user1Target === 'HookWalk', 'T40: my goal on screen');
  await until(() => (pact().user1DoneDates || []).includes(today), 'T40: today ticked on screen');
  eq([pact().user2Target, pact().title], ['Run', 'Walk daily'], 'T40: partner goal and title on screen unchanged');
  await until(() => (srv().user1_done_dates || []).includes(today), 'T40: today ticked on the server', 5000);
  eq([srv().user1_target, srv().user2_target, srv().title, srv().start_date], ['HookWalk', 'Run', 'Walk daily', start], 'T40: server row: only my goal changed');
  eq(srv().user1_done_dates, [start, today], 'T40: past days kept, today added');
  eq(srv().user2_done_dates, [start], "T40: the partner's days untouched");

  // T41
  let refused = '';
  await h.s().linkSharedChallengeSide(PACT2, 'HookRead').catch((e: Error) => (refused = e.message));
  eq(refused, 'You ticked today already. Finish HookRead today first, or link it tomorrow.', 'T41: refused with a message');
  eq(linkCalls.length, 1, 'T41: nothing sent');
  eq(pact(PACT2).user1Target, 'Read', 'T41: goal unchanged');

  // T42
  refuseNext = 'This challenge has ended, so it can no longer change.';
  let serverRefused = '';
  await h.s().linkSharedChallengeSide(PACT2, 'Read with Ali').catch((e: Error) => (serverRefused = e.message));
  eq(serverRefused, 'This challenge has ended, so it can no longer change.', "T42: the server's reason reaches the form");
  await quiet(300);
  eq(pact(PACT2).user1Target, 'Read', 'T42: my goal back on screen');
  eq(srv(PACT2).user1_target, 'Read', 'T42: server row unchanged');

  // T43
  const r43 = await h.s().linkSharedChallengeSide(PACT2, 'Read with Ali');
  eq(r43, { changed: true, tickedToday: false, todayTickFailed: false }, 'T43: saved, nothing to tick');
  await until(() => pact(PACT2).user1Target === 'Read with Ali', 'T43: new name on screen');
  eq(srv(PACT2).user1_target, 'Read with Ali', 'T43: new name on the server');
  assert((pact(PACT2).user1DoneDates || []).includes(today), "T43: today's hand tick kept");
  eq(await h.s().linkSharedChallengeSide(PACT2, 'Read with Ali'), { changed: false, tickedToday: false, todayTickFailed: false }, 'T43: the same name again sends nothing');
  eq(linkCalls.length, 3, 'T43: no extra call for an unchanged name');
  pass('T40-T43 link later: own goal only, today ticks from a done habit, hand tick protected, server refusal rolls back, unlink keeps today');
});
