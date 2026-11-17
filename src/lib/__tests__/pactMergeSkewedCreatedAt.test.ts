// Two copies of the same pact merge with the incoming (newer) copy's goals, whatever their createdAt.
// Bug: mergeSharedChallenge took the copy with the later createdAt as primary. The creator's own
// copy keeps the device's creation time; a device clock ahead of the server's put it after the row's
// created_at, so that copy's old goal beat a relink made on another device (ascend_pact_link_side)
// on every realtime row, refresh and save answer, for good.
// Mutation proof: with the old rule (primary = later createdAt, ids ignored) blocks 1-3 fail; block 4
// (two different pacts with one running title) passes on both rules.
import { DEFAULT_STATE, type AppState, type SharedChallenge } from '@/types';
import { mergeSharedChallenge } from '../partners/pactLifecycle';
import { mergeAppState } from '../store/stateMerger';
import { trustedNow } from '../time/clock';
import { todayKey } from '../time/dates';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const nowMs = trustedNow().getTime();
const iso = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
const SERVER_CREATED = iso(-60_000);
// The creator's device clock was 30 s ahead when it stamped its copy.
const DEVICE_CREATED = iso(-30_000);

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
    createdAt: SERVER_CREATED,
    startDate: todayKey(),
    ...extra,
  };
}

// 1. The creator's skewed copy on screen, the relinked server row arrives (realtime / refresh).
{
  const onScreen = pact({ createdAt: DEVICE_CREATED });
  const relinked = pact({ user1Target: 'Walk', user1Category: 'habit' });
  const merged = mergeSharedChallenge(onScreen, relinked);
  assert(merged.user1Target === 'Walk', `relink from another device wins (got ${merged.user1Target})`);
  assert(merged.user2Target === 'Run', "partner's side unchanged");
  assert(merged.createdAt === SERVER_CREATED, "the merged copy takes the server's createdAt");
}

// 2. The same through mergeAppState (base = on screen, incoming = the newer copy).
{
  const state = (c: SharedChallenge): AppState => ({ ...DEFAULT_STATE, sharedChallenges: [c] }) as AppState;
  const merged = mergeAppState(
    state(pact({ createdAt: DEVICE_CREATED })),
    state(pact({ user1Category: 'bad_habit', user1Target: 'Soda' })),
    'hydration'
  );
  const c = merged.sharedChallenges.find((x) => x.id === 'c1');
  assert(c?.user1Target === 'Soda' && c?.user1Category === 'bad_habit', `relinked side wins in mergeAppState (got ${c?.user1Category}/${c?.user1Target})`);
}

// 3. Done dates still come from the incoming copy, and a second relink still wins after the first merge.
{
  const today = todayKey();
  const first = mergeSharedChallenge(
    pact({ createdAt: DEVICE_CREATED, user1DoneDates: [today] }),
    pact({ user1Target: 'Walk', user1DoneDates: [today] })
  );
  const second = mergeSharedChallenge(first, pact({ user1Target: 'Swim', user1DoneDates: [today] }));
  assert(second.user1Target === 'Swim', `second relink wins (got ${second.user1Target})`);
  assert(second.user1DoneDates?.length === 1 && second.user1DoneDates[0] === today, 'ticked day kept');
}

// 4. Two different pacts with one running title (deduped): the newer-created one still wins (unchanged).
{
  const older = pact({ id: 'c-old', createdAt: iso(-120_000), user1Target: 'Old goal' });
  const newer = pact({ id: 'c-new', createdAt: iso(-10_000), user1Target: 'New goal' });
  assert(mergeSharedChallenge(newer, older).id === 'c-new', 'newer-created pact kept (base newer)');
  assert(mergeSharedChallenge(older, newer).id === 'c-new', 'newer-created pact kept (incoming newer)');
  assert(mergeSharedChallenge(newer, older).user1Target === 'New goal', "newer-created pact's goal kept");
}

console.log('pactMergeSkewedCreatedAt: all assertions passed');
