// A load over a dirty device cache (the last save never finished) takes pacts and partnerships from
// the hydrated state, not from the cache (knowledge/mode-a-shared-challenge-flash-2026-11-21.md, fix A).
// Bug: the cached copies went in as `incoming`, so mergeSharedChallenge kept their old goals and
// missing partner ticks, and the union brought back pacts deleted and partnerships ended on the
// server, until the partner refresh replaced them.
//   1 stale goal + missing partner tick: the server's values
//   2 a pact deleted on the server, only in the cache: gone
//   3 a partnership ended on the server: gone, and the `partnership` scalar is the live one
//   4 the challenge/partnership fetch failed (hydrated holds the cache): cached pacts still shown
//   5 a pact with a write of ours on its way keeps the copy on screen
// Mutation proof: without withHydratedPartnerData (cache as before) 1, 2, 3, 3b and the second check of
// 5 fail; 4 passes on both.
import { DEFAULT_STATE, type AppState, type Partnership, type SharedChallenge } from '@/types';
import { mergeAppStateWithGuardResult } from '../store/stateMerger';
import { cacheWithHydratedCollections, withHydratedPartnerData } from '../sync/syncedCollections';
import { trustedNow } from '../time/clock';
import { todayKey, addDays } from '../time/dates';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const today = todayKey();
const created = new Date(trustedNow().getTime() - 86_400_000).toISOString();
const at = 'Sun 2026-11-01 5:00 AM PKT (UTC+05:00)';

function pact(extra: Partial<SharedChallenge>): SharedChallenge {
  return {
    id: 'c1',
    partnershipId: 'p1',
    title: 'Morning pact',
    targetHabitName: 'Read',
    durationDays: 7,
    jointStreak: 0,
    user1Category: 'habit',
    user1Target: 'Read',
    user2Category: 'habit',
    user2Target: 'Run',
    user1DoneDates: [],
    user2DoneDates: [],
    status: 'active',
    createdAt: created,
    startDate: addDays(today, -1),
    ...extra,
  };
}
const live: Partnership = { id: 'p1', user1Id: 'u1', user1Username: 'a', user2Id: 'u2', user2Username: 'b', pairedAt: at };
const ended: Partnership = { id: 'p0', user1Id: 'u1', user1Username: 'a', user2Id: 'u3', user2Username: 'c', pairedAt: at };

const state = (sharedChallenges: SharedChallenge[], partnerships: Partnership[], partnership: Partnership | null): AppState =>
  ({ ...DEFAULT_STATE, sharedChallenges, partnerships, partnership }) as AppState;

// The store's dirty path: cache with hydrated collections, partner data from hydrated, then the merge.
function dirtyLoad(cache: AppState, hydrated: AppState, keep?: ReadonlySet<string>): AppState {
  const device = withHydratedPartnerData(cacheWithHydratedCollections(cache, hydrated, {}), hydrated, keep);
  return mergeAppStateWithGuardResult(hydrated, device, undefined).mergedState;
}

const serverPact = pact({ user1Target: 'Walk', user2DoneDates: [today] });
const cachedPact = pact({});
const ghost = pact({ id: 'c2', title: 'Deleted on server', user1Target: 'Swim' });

// 1-3. Server rows hydrated; the dirty cache holds older copies, a deleted pact and an ended partnership.
{
  const hydrated = state([serverPact], [live], live);
  const cache = state([cachedPact, ghost], [live, ended], ended);
  const out = dirtyLoad(cache, hydrated);
  const c1 = out.sharedChallenges.find((c) => c.id === 'c1');
  assert(c1?.user1Target === 'Walk', `1: server goal (got ${c1?.user1Target})`);
  assert(JSON.stringify(c1?.user2DoneDates) === JSON.stringify([today]), `1: partner's tick today (got ${JSON.stringify(c1?.user2DoneDates)})`);
  assert(!out.sharedChallenges.some((c) => c.id === 'c2'), '2: pact deleted on the server is not shown');
  assert(out.sharedChallenges.length === 1, `2: one pact (got ${out.sharedChallenges.length})`);
  assert(JSON.stringify(out.partnerships.map((p) => p.id)) === JSON.stringify(['p1']), `3: ended partnership gone (got ${out.partnerships.map((p) => p.id)})`);
  assert(out.partnership?.id === 'p1', `3: partnership scalar is the live one (got ${out.partnership?.id})`);
}

// 3b. The partner's last tick completed the pact on the server: not shown as active from the cache.
{
  const days = [addDays(today, -1), today];
  const cachedTwoDay = pact({ durationDays: 2, user1DoneDates: days, user2DoneDates: [days[0]] });
  const done = pact({ durationDays: 2, user1DoneDates: days, user2DoneDates: days, status: 'completed' });
  const out = dirtyLoad(state([cachedTwoDay], [live], live), state([done], [live], live));
  assert(out.sharedChallenges[0]?.status === 'completed', `3b: server status (got ${out.sharedChallenges[0]?.status})`);
}

// 4. Fetches failed: hydration keeps the cache (authSession seeds it), so the cached pacts stay.
{
  const cache = state([cachedPact, ghost], [live], live);
  const hydrated = state([cachedPact, ghost], [live], live);
  const out = dirtyLoad(cache, hydrated);
  assert(
    JSON.stringify(out.sharedChallenges.map((c) => c.id).sort()) === JSON.stringify(['c1', 'c2']),
    `4: cached pacts shown offline (got ${out.sharedChallenges.map((c) => c.id)})`
  );
  assert(out.partnership?.id === 'p1', '4: cached partnership shown offline');
}

// 5. Background load: today's tick on screen with its write on its way, the hydrated read predates it.
{
  const onScreen = pact({ user1DoneDates: [today] });
  const hydrated = state([pact({}), pact({ id: 'c3', title: 'Other pact', user2DoneDates: [today] })], [live], live);
  const cache = state([onScreen, pact({ id: 'c3', title: 'Other pact' })], [live], live);
  const out = dirtyLoad(cache, hydrated, new Set(['c1']));
  const c1 = out.sharedChallenges.find((c) => c.id === 'c1');
  const c3 = out.sharedChallenges.find((c) => c.id === 'c3');
  assert(JSON.stringify(c1?.user1DoneDates) === JSON.stringify([today]), `5: in-flight tick kept (got ${JSON.stringify(c1?.user1DoneDates)})`);
  assert(JSON.stringify(c3?.user2DoneDates) === JSON.stringify([today]), '5: a pact with no write in flight takes the server copy');
}

console.log('bootPactCache: OK');
