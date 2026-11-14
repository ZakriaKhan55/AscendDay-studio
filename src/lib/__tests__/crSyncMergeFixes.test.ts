// CodeRabbit phase 2 fixes (knowledge/mode-a-cr-p2-sync-2026-11-14.md), pure functions:
// CR-06-8  parseDate refuses a calendar day the month does not have.
// CR-05-25 the merge drops a recovery tracker that either side deleted.
// CR-05-19 load-time dedupe of bad-habit logs keeps the last changed log, like the merge.
// CR-05-15 an empty server points ledger, when every table was read, clears the last stale preview.
import { DEFAULT_STATE, type AppState, type AddictionTracker, type BadHabitLog, type PointsEntry } from '@/types';
import { localDayStartMs, parseDate } from '../time/dates';
import { mergeAppState } from '../store/stateMerger';
import { sanitizeLoadedState } from '../store/loadedState';
import { withHydratedPoints } from '../points/stateAwards';
import { trustedNow } from '../time/clock';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const state = (overrides: Partial<AppState>) => ({ ...DEFAULT_STATE, ...overrides }) as AppState;

// ---------------------------------------------------------------- CR-06-8
{
  assert(parseDate('2026-02-30') === null, '2026-02-30 is invalid (not March 2)');
  assert(parseDate('2026-04-31') === null, '2026-04-31 is invalid');
  assert(parseDate('2026-13-01') === null, 'month 13 is invalid');
  assert(parseDate('2026-00-10') === null, 'month 0 is invalid');
  assert(parseDate('2025-02-29') === null, '29 Feb in a common year is invalid');
  assert(Number.isNaN(localDayStartMs('2026-02-30')), 'localDayStartMs of an invalid key is NaN');
  const leap = parseDate('2028-02-29');
  assert(leap !== null && leap.getMonth() === 1 && leap.getDate() === 29, '29 Feb in a leap year is valid');
  const d = parseDate('2026-11-14');
  assert(d !== null && d.getFullYear() === 2026 && d.getMonth() === 10 && d.getDate() === 14 && d.getHours() === 0, 'a valid key is local midnight');
  assert(parseDate('2026-12-31')?.getDate() === 31, 'month end is valid');
}

// ---------------------------------------------------------------- CR-05-25
{
  const tracker = (id: string, startDate: string): AddictionTracker => ({
    id,
    title: 'Sobriety',
    startDate,
    milestonesUnlocked: [],
    createdAt: '2026-11-01T00:00:00.000Z',
  });
  // Deleted on the base side (this device), the incoming copy still holds it: it stays deleted.
  const deletedHere = mergeAppState(
    state({ addictionTracker: null, deletedEntityIds: ['t1'] }),
    state({ addictionTracker: tracker('t1', '2026-11-01T00:00:00.000Z') })
  );
  assert(deletedHere.addictionTracker === null, 'a tracker deleted on the base side is not brought back');
  // Same id on both sides (the same-id merge) and deleted on one: still dropped.
  const bothHold = mergeAppState(
    state({ addictionTracker: tracker('t1', '2026-11-02T00:00:00.000Z'), deletedEntityIds: ['t1'] }),
    state({ addictionTracker: tracker('t1', '2026-11-01T00:00:00.000Z') })
  );
  assert(bothHold.addictionTracker === null, 'the same-id merge result is dropped when deleted');
  // A new tracker (new id) after a delete is kept.
  const fresh = mergeAppState(
    state({ addictionTracker: null, deletedEntityIds: ['t1'] }),
    state({ addictionTracker: tracker('t2', '2026-11-03T00:00:00.000Z') })
  );
  assert(fresh.addictionTracker?.id === 't2', 'a new tracker after a delete is kept');
  // No tombstones: unchanged behaviour.
  const plain = mergeAppState(state({ addictionTracker: null }), state({ addictionTracker: tracker('t1', '2026-11-01T00:00:00.000Z') }));
  assert(plain.addictionTracker?.id === 't1', 'a tracker nobody deleted is kept');
}

// ---------------------------------------------------------------- CR-05-19
{
  const log = (id: string, status: BadHabitLog['status'], createdAt: string, updatedAt?: string): BadHabitLog => ({
    id,
    badHabitId: 'b1',
    date: '2026-11-10',
    status,
    pointsAwardedOrDeducted: 0,
    createdAt,
    ...(updatedAt ? { updatedAt } : {}),
  });
  // a1 was created first but edited after a2 was created: the edit is the newest change.
  const logs = [
    log('a1', 'resisted', '2026-11-10T08:00:00.000Z', '2026-11-10T12:00:00.000Z'),
    log('a2', 'occurred', '2026-11-10T09:00:00.000Z'),
  ];
  const loaded = sanitizeLoadedState({ badHabitLogs: logs }, null);
  assert(loaded.badHabitLogs.length === 1 && loaded.badHabitLogs[0].id === 'a1', 'load keeps the last changed log (updatedAt)');
  const merged = mergeAppState(state({ badHabitLogs: [logs[0]] }), state({ badHabitLogs: [logs[1]] }));
  assert(merged.badHabitLogs.length === 1 && merged.badHabitLogs[0].id === 'a1', 'the merge picks the same log');
  // Without updatedAt the later created log still wins.
  const older = sanitizeLoadedState({ badHabitLogs: [log('c1', 'resisted', '2026-11-10T08:00:00.000Z'), log('c2', 'occurred', '2026-11-10T09:00:00.000Z')] }, null);
  assert(older.badHabitLogs.length === 1 && older.badHabitLogs[0].id === 'c2', 'no edit times: the later created log');
}

// ---------------------------------------------------------------- CR-05-15
{
  const now = trustedNow().toISOString();
  const entry = (id: string, amount: number): PointsEntry => ({ id, amount, reason: 'Habit', source: 'habit', timestamp: now });
  const merged = state({ pointsHistory: [entry('preview_1', 5)], seasonPoints: 5, totalPoints: 5 });
  const emptyServer = state({ pointsHistory: [] });
  const cleared = withHydratedPoints(merged, emptyServer, true);
  assert(cleared.pointsHistory.length === 0 && cleared.seasonPoints === 0 && cleared.totalPoints === 0, 'every table read, server empty: the stale preview goes');
  assert(withHydratedPoints(merged, emptyServer, false) === merged, 'a failed read (empty, not trusted) keeps the merge');
  const kept = withHydratedPoints(state({ pointsHistory: [entry('p1', 3), entry('preview_1', 5)], seasonPoints: 8, totalPoints: 8 }), state({ pointsHistory: [entry('p1', 3)] }), false);
  assert(kept.pointsHistory.length === 1 && kept.pointsHistory[0].id === 'p1', 'a server ledger with rows filters as before');
}

console.log('crSyncMergeFixes: all passed');
