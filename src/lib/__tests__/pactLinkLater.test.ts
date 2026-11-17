// Link my side of a running challenge later (pactSideLinkCheck / canChangePactLink / withPactSideGoal).
//   L1  a Do side links to one of my daily habits (Reading included) by name; weekly habits don't link
//   L2  a Resist side links only to an active bad habit; a habit with that name doesn't count
//   L3  today: a habit already done today ticks today; a hand tick today is never taken back by a link
//       (refused with a message), unlinking keeps it; before day 1 nothing ticks
//   L4  finished pacts and a viewer whose last day is over can't change; empty / too long names refused
//   L5  withPactSideGoal changes only the viewer's own goal (partner, title, dates untouched)
import type { BadHabit, BadHabitLog, Habit, SharedChallenge } from '@/types';
import { addDays } from '../time/dates';
import {
  canChangePactLink,
  linkedHabitFor,
  pactSideLinkCheck,
  withPactSideGoal,
  PACT_GOAL_MAX_LENGTH,
} from '../partners/pactLifecycle';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const START = '2026-11-15';
const TODAY = '2026-11-17';
const AT = 'Sun 2026-11-15 10:00 AM PKT (UTC+05:00)';

function habit(id: string, name: string, extra: Partial<Habit> = {}): Habit {
  return { id, name, frequency: 'daily', points: 1, isPreset: false, createdAt: AT, createdAtPeriod: START, completions: {}, ...extra };
}
function badHabit(id: string, name: string, extra: Partial<BadHabit> = {}): BadHabit {
  return { id, name, isPreset: false, isCompleted: false, createdAt: AT, ...extra };
}
function log(badHabitId: string, status: BadHabitLog['status'], date = TODAY): BadHabitLog {
  return { id: `${badHabitId}_${date}`, badHabitId, date, status, pointsAwardedOrDeducted: 0, createdAt: AT };
}
function pact(extra: Partial<SharedChallenge> = {}): SharedChallenge {
  return {
    id: 'c1', partnershipId: 'p1', title: 'Walk', targetHabitName: 'Walk', durationDays: 7, jointStreak: 0,
    user1Category: 'habit', user1Target: 'Walk', user2Category: 'habit', user2Target: 'Run',
    user1DoneDates: [START], user2DoneDates: [START], status: 'active', createdAt: AT, startDate: START,
    ...extra,
  };
}
const check = (p: SharedChallenge, goal: string, o: { isUser1?: boolean; habits?: Habit[]; badHabits?: BadHabit[]; logs?: BadHabitLog[]; today?: string } = {}) =>
  pactSideLinkCheck({ challenge: p, isUser1: o.isUser1 ?? true, goal, habits: o.habits ?? [], badHabits: o.badHabits ?? [], badHabitLogs: o.logs ?? [], today: o.today ?? TODAY });

const walk = habit('h1', 'Morning walk');
const walkDone = habit('h1', 'Morning walk', { completions: { [TODAY]: { done: true, updatedAt: AT } } });
const reading = habit('hr', 'Reading (Books)', { linkedModule: 'reading', completions: { [TODAY]: { done: true, updatedAt: AT } } });
const weekly = habit('hw', 'Gym', { frequency: 'weekly' });

// L1
{
  const r = check(pact(), '  morning   WALK ', { habits: [walk] });
  assert(r.ok && r.goal === 'morning WALK' && r.linksTo === 'Morning walk' && !r.unchanged, 'L1: my side links to my daily habit by name (trimmed)');
  assert(r.ok && !r.ticksToday, 'L1: habit not done today: no tick');
  const rr = check(pact(), 'Reading (Books)', { habits: [reading] });
  assert(rr.ok && rr.linksTo === 'Reading (Books)' && rr.ticksToday, 'L1: the Reading habit links and ticks today when read today');
  const w = check(pact(), 'Gym', { habits: [weekly] });
  assert(w.ok && w.linksTo === null, 'L1: a weekly habit does not link (hand tick)');
  const u2 = check(pact(), 'Morning walk', { isUser1: false, habits: [walkDone] });
  assert(u2.ok && u2.linksTo === 'Morning walk' && u2.ticksToday, 'L1: user2 checks their own side (their today not ticked yet)');
  const same = check(pact(), ' Walk ', { habits: [walk] });
  assert(same.ok && same.unchanged, 'L1: the same name is unchanged');
}

// L2
{
  const resist = pact({ user1Category: 'bad_habit', user2Category: 'bad_habit', user1Target: 'Junk food', user2Target: 'Junk food', user1DoneDates: [], user2DoneDates: [] });
  const doom = badHabit('b1', 'Doomscrolling');
  const r = check(resist, 'doomscrolling', { badHabits: [doom], habits: [habit('hd', 'Doomscrolling')] });
  assert(r.ok && r.linksTo === 'Doomscrolling' && !r.ticksToday, 'L2: resist side links to my active bad habit, not logged yet: no tick');
  const logged = check(resist, 'Doomscrolling', { badHabits: [doom], logs: [log('b1', 'resisted')] });
  assert(logged.ok && logged.ticksToday, 'L2: logged Resisted today: today ticks');
  const slipped = check(resist, 'Doomscrolling', { badHabits: [doom], logs: [log('b1', 'occurred')] });
  assert(slipped.ok && !slipped.ticksToday, 'L2: a slip today: no tick');
  const stopped = check(resist, 'Doomscrolling', { badHabits: [badHabit('b1', 'Doomscrolling', { isCompleted: true })] });
  assert(stopped.ok && stopped.linksTo === null, 'L2: a stopped bad habit does not link');
  const onlyHabit = check(resist, 'Doomscrolling', { habits: [habit('hd', 'Doomscrolling')] });
  assert(onlyHabit.ok && onlyHabit.linksTo === null, 'L2: a daily habit with that name does not link a resist side');
}

// L3
{
  const ticked = pact({ user1DoneDates: [START, TODAY] });
  const refused = check(ticked, 'Morning walk', { habits: [walk] });
  assert(!refused.ok && refused.error === 'You ticked today already. Finish Morning walk today first, or link it tomorrow.', `L3: hand tick today + habit not done: refused (got ${JSON.stringify(refused)})`);
  const readRefused = check(ticked, 'Reading (Books)', { habits: [habit('hr', 'Reading (Books)', { linkedModule: 'reading' })] });
  assert(!readRefused.ok && readRefused.error.includes('Log reading today first'), 'L3: Reading: log reading first');
  const both = check(ticked, 'Morning walk', { habits: [walkDone] });
  assert(both.ok && !both.ticksToday, 'L3: ticked today and habit done: allowed, nothing to tick');
  const unlink = check(ticked, 'Walk with Ali', { habits: [walk] });
  assert(unlink.ok && unlink.linksTo === null && !unlink.ticksToday, 'L3: a name that links to nothing keeps the hand tick');
  const notStarted = pact({ startDate: addDays(TODAY, 1), user1DoneDates: [], user2DoneDates: [] });
  const ns = check(notStarted, 'Morning walk', { habits: [walkDone] });
  assert(ns.ok && ns.linksTo === 'Morning walk' && !ns.ticksToday, 'L3: before day 1: link allowed, no tick');
  assert(JSON.stringify(ticked.user1DoneDates) === JSON.stringify([START, TODAY]), 'L3: the check changes no days');
}

// L4
{
  for (const status of ['completed', 'expired', 'broken'] as const) {
    const r = check(pact({ status }), 'Morning walk', { habits: [walk] });
    assert(!r.ok && r.error === 'This challenge has ended, so it can no longer change.', `L4: ${status} refused`);
    assert(!canChangePactLink(pact({ status }), TODAY), `L4: ${status}: no link button`);
  }
  const over = pact({ startDate: addDays(TODAY, -7) });
  assert(!canChangePactLink(over, TODAY) && !check(over, 'Morning walk', { habits: [walk] }).ok, 'L4: my day 8 of 7: refused');
  assert(canChangePactLink(pact({ startDate: addDays(TODAY, -6) }), TODAY), 'L4: my last day: allowed');
  const empty = check(pact(), '   ');
  assert(!empty.ok && empty.error === 'Write what you will do every day.', 'L4: empty name refused');
  const long = check(pact(), 'x'.repeat(PACT_GOAL_MAX_LENGTH + 1));
  assert(!long.ok, 'L4: too long refused');
  assert(check(pact(), 'x'.repeat(PACT_GOAL_MAX_LENGTH)).ok, 'L4: 80 characters allowed');
}

// L5
{
  const p = pact();
  const mine = withPactSideGoal(p, true, 'Morning walk');
  assert(mine.user1Target === 'Morning walk' && mine.user2Target === 'Run' && mine.title === 'Walk', 'L5: user1 goal only');
  assert(JSON.stringify(mine.user1DoneDates) === JSON.stringify(p.user1DoneDates) && mine.startDate === p.startDate, 'L5: days and start untouched');
  assert(linkedHabitFor(mine, true, [walk])?.id === 'h1' && linkedHabitFor(p, true, [walk]) === null, 'L5: the new goal links, the old did not');
  const theirs = withPactSideGoal(p, false, 'Evening run');
  assert(theirs.user2Target === 'Evening run' && theirs.user1Target === 'Walk', 'L5: user2 goal only');
}

console.log('PASS pactLinkLater L1-L5');
