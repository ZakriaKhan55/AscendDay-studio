// Realtime partner events as pure state transforms (src/lib/partners/partnerEvents.ts), and the log an
// account load replays them from (knowledge: partner flash during an account load, deferred finding).
// Mutation proof: applyPartnerEvent without the tombstone guard fails "upsert of a tombstoned pact";
// a log whose since() ignores seq fails "since skips older events"; record() keeping another
// account's entries fails "account switch"; since() without the gap check fails "bounded log".
import type { AppState, Partnership, PartnerInvite, SharedChallenge } from '@/types';
import { DEFAULT_STATE } from '@/types';
import { PartnerEventLog, applyPartnerEvent, sharedChallengeFromRow, type PartnerEvent } from '../partners/partnerEvents';
import { addDays, todayKey } from '../time/dates';

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) =>
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const today = todayKey();
const start = addDays(today, -2);
const createdAt = 'Sat 2026-11-21 1:00 AM PKT (UTC+05:00)';

const pact = (id: string, partnershipId: string, extra: Partial<SharedChallenge> = {}): SharedChallenge => ({
  id, partnershipId, title: 'Pact', targetHabitName: 'Walk', durationDays: 7, jointStreak: 0,
  user1Category: 'habit', user1Target: 'Walk', user2Category: 'habit', user2Target: 'Run',
  user1DoneDates: [], user2DoneDates: [start], status: 'active', createdAt, startDate: start, ...extra,
});
const ps = (id: string): Partnership => ({ id, user1Id: 'u1', user1Username: 'me', user2Id: `x-${id}`, user2Username: `pal-${id}`, pairedAt: createdAt });
const invite = (id: string): PartnerInvite => ({
  id, fromUserId: 'x', fromUsername: 'someone', fromAvatar: '🦊', toUserId: 'u1', toUsername: 'me', status: 'pending', createdAt,
});
const state = (extra: Partial<AppState> = {}): AppState => ({
  ...DEFAULT_STATE,
  partnerships: [ps('p1'), ps('p2')],
  partnership: ps('p1'),
  sharedChallenges: [pact('c1', 'p1'), pact('c2', 'p2')],
  partnerInvites: [invite('i1'), invite('i2')],
  deletedEntityIds: [],
  ...extra,
});

function deletes() {
  const s = state();
  const a = applyPartnerEvent(s, { kind: 'inviteDeleted', id: 'i1' });
  eq(a.partnerInvites.map((i) => i.id), ['i2'], 'invite removed');
  eq(a.deletedEntityIds, ['i1'], 'invite tombstoned');

  const b = applyPartnerEvent(s, { kind: 'partnershipDeleted', id: 'p1' });
  eq(b.partnerships.map((p) => p.id), ['p2'], 'partnership removed');
  eq(b.partnership?.id, 'p2', 'next partnership becomes the current one');
  eq(b.sharedChallenges.map((c) => c.id), ['c2'], 'its pacts removed');
  eq(b.deletedEntityIds, ['p1'], 'partnership tombstoned');
  eq(applyPartnerEvent(b, { kind: 'partnershipDeleted', id: 'p2' }).partnership, null, 'last partnership gone: none');

  const c = applyPartnerEvent(s, { kind: 'pactDeleted', id: 'c2' });
  eq(c.sharedChallenges.map((x) => x.id), ['c1'], 'pact removed');
  eq(c.deletedEntityIds, ['c2'], 'pact tombstoned');
  assert(s.sharedChallenges.length === 2 && (s.deletedEntityIds || []).length === 0, 'input state not mutated');

  const full = state({ deletedEntityIds: Array.from({ length: 500 }, (_, i) => `t${i}`) });
  const d = applyPartnerEvent(full, { kind: 'pactDeleted', id: 'c1' });
  assert(d.deletedEntityIds!.length === 500 && d.deletedEntityIds![499] === 'c1' && d.deletedEntityIds![0] === 't1', 'tombstones capped at 500, newest last');
  console.log('deletes passed');
}

function upserts() {
  const s = state();
  const updated = applyPartnerEvent(s, { kind: 'pactUpserted', challenge: pact('c1', 'p1', { user2DoneDates: [start, today], title: 'Renamed' }) });
  const c1 = updated.sharedChallenges.find((c) => c.id === 'c1')!;
  eq(c1.user2DoneDates, [start, today], 'update: incoming done dates win');
  eq(c1.title, 'Renamed', 'update: incoming fields win');
  eq(updated.sharedChallenges.map((c) => c.id), ['c1', 'c2'], 'update keeps the order');

  const inserted = applyPartnerEvent(s, { kind: 'pactUpserted', challenge: pact('c3', 'p2') });
  eq(inserted.sharedChallenges.map((c) => c.id), ['c3', 'c1', 'c2'], 'insert goes first');

  const tomb = state({ deletedEntityIds: ['c1'] });
  assert(applyPartnerEvent(tomb, { kind: 'pactUpserted', challenge: pact('c1', 'p1') }) === tomb, 'upsert of a tombstoned pact: same state');
  const tombPs = state({ deletedEntityIds: ['p2'] });
  assert(applyPartnerEvent(tombPs, { kind: 'pactUpserted', challenge: pact('c9', 'p2') }) === tombPs, 'upsert into a tombstoned partnership: same state');

  // Replaying the same event twice ends at the same pact (a read that already held it).
  const once = applyPartnerEvent(s, { kind: 'pactUpserted', challenge: pact('c1', 'p1', { user2DoneDates: [start, today] }) });
  const twice = applyPartnerEvent(once, { kind: 'pactUpserted', challenge: pact('c1', 'p1', { user2DoneDates: [start, today] }) });
  eq(twice.sharedChallenges, once.sharedChallenges, 'upsert is idempotent');
  console.log('upserts passed');
}

function rowMapping() {
  const c = sharedChallengeFromRow({
    id: 'c1', partnership_id: 'p1', title: 'T', target_habit_name: 'Walk', duration_days: 7, joint_streak: 0,
    user1_done_dates: [], user1_done_date: today, user2_done_dates: [start, today], status: 'active', created_at: createdAt, start_date: start,
  });
  eq(c.user1DoneDates, [today], 'legacy one-day column used when the array is empty');
  eq(c.user2DoneDates, [start, today], 'array used when present');
  eq([c.user1Category, c.user1Target, c.user2Target], ['habit', 'Walk', 'Walk'], 'defaults from the target habit');
  eq(c.startDate, start, 'start date kept');
  assert(!('startDate' in sharedChallengeFromRow({ id: 'c2', partnership_id: 'p1', start_date: null })), 'no start date when the row has none');
  console.log('row mapping passed');
}

const sizeOf = (l: PartnerEventLog): number => l.size;

function log() {
  const del = (id: string): PartnerEvent => ({ kind: 'pactDeleted', id });
  const l = new PartnerEventLog(3);
  l.record('A', 2, del('a'));
  l.record('A', 5, del('b'));
  l.record('A', 7, del('c'));
  eq(l.since('A', 4)?.map((e) => e.seq), [5, 7], 'since skips older events');
  eq(l.since('A', 0)?.map((e) => e.seq), [2, 5, 7], 'since 0: all, in order');
  eq(l.since('B', 0), [], 'another account: nothing');

  l.record('A', 9, del('d'));
  assert(sizeOf(l) === 3, 'bounded log keeps the newest');
  assert(l.since('A', 1) === null, 'bounded log: a read older than a dropped event sees a gap');
  eq(l.since('A', 2)?.map((e) => e.seq), [5, 7, 9], 'bounded log: a read newer than the dropped event replays the rest');

  l.prune(5);
  eq(l.since('A', 0)?.map((e) => e.seq), [7, 9], 'prune drops what a newer read holds (and the gap behind it)');

  l.record('B', 11, del('e'));
  eq(l.since('A', 0), [], 'account switch: the old account\'s events are gone');
  eq(l.since('B', 0)?.map((e) => e.seq), [11], 'account switch: the new account starts afresh');

  l.clear();
  assert(sizeOf(l) === 0 && (l.since('B', 0) ?? []).length === 0, 'clear empties the log');
  console.log('log passed');
}

deletes();
upserts();
rowMapping();
log();
console.log('partnerEvents tests passed');
