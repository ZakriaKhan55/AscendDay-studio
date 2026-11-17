// A book's target date, start and finish dates and takeaway must come from the newer copy, like
// its unit, progress and length (bookMergeLength). Before the fix the merger always took the
// INCOMING copy's value when it had one, and the other copy's value when it had none, so an older
// copy could put back an old target date or takeaway, or a finish date a restart had cleared.
import { DEFAULT_STATE, type AppState, type UserBook } from '@/types';
import { mergeAppState } from '../store/stateMerger';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function state(libraryBooks: UserBook[]): AppState {
  return { ...DEFAULT_STATE, libraryBooks } as AppState;
}

function book(overrides: Partial<UserBook>): UserBook {
  return {
    id: 'b1',
    title: 'The Power of Now',
    author: 'Eckhart Tolle',
    status: 'reading',
    pointsReward: 0,
    pointsAwarded: 0,
    addedAt: '2026-11-01T10:00:00.000Z',
    ...overrides,
  } as UserBook;
}

const pair = (base: UserBook, inc: UserBook) => mergeAppState(state([base]), state([inc])).libraryBooks[0];

function run() {
  console.log('Running book merge newer-fields tests...\n');

  // 1. Both copies have every field: the newer copy's values win, in both directions.
  {
    const older = book({
      targetFinishDate: '2026-11-20',
      dateStarted: '2026-11-02T10:00:00.000Z',
      startedAt: '2026-11-02T10:00:00.000Z',
      dateCompleted: '2026-11-05T10:00:00.000Z',
      completedAt: '2026-11-05T10:00:00.000Z',
      reflection: 'Old takeaway',
      status: 'completed',
      updatedAt: '2026-11-05T10:00:00.000Z',
    });
    const newer = book({
      targetFinishDate: '2026-12-31',
      dateStarted: '2026-11-08T10:00:00.000Z',
      startedAt: '2026-11-08T10:00:00.000Z',
      dateCompleted: '2026-11-09T10:00:00.000Z',
      completedAt: '2026-11-09T10:00:00.000Z',
      reflection: 'New takeaway',
      status: 'completed',
      updatedAt: '2026-11-09T10:00:00.000Z',
    });
    for (const [label, base, inc] of [['newer base, older incoming', newer, older], ['older base, newer incoming', older, newer]] as const) {
      const m = pair(base, inc);
      assert(m.targetFinishDate === '2026-12-31', `${label}: target date from the newer copy`);
      assert(m.dateStarted === '2026-11-08T10:00:00.000Z' && m.startedAt === '2026-11-08T10:00:00.000Z', `${label}: start date from the newer copy`);
      assert(m.dateCompleted === '2026-11-09T10:00:00.000Z' && m.completedAt === '2026-11-09T10:00:00.000Z', `${label}: finish date from the newer copy`);
      assert(m.reflection === 'New takeaway', `${label}: takeaway from the newer copy`);
    }
  }

  // 2. The newer copy removed them (restart clears the finish date, the form clears the target date
  //    and takeaway): the older copy does not bring them back, in either direction.
  {
    const finished = book({
      status: 'completed',
      targetFinishDate: '2026-11-20',
      dateCompleted: '2026-11-05T10:00:00.000Z',
      completedAt: '2026-11-05T10:00:00.000Z',
      reflection: 'Old takeaway',
      updatedAt: '2026-11-05T10:00:00.000Z',
    });
    const cleared = book({ status: 'reading', dateStarted: '2026-11-09T10:00:00.000Z', startedAt: '2026-11-09T10:00:00.000Z', updatedAt: '2026-11-09T10:00:00.000Z' });
    for (const [label, base, inc] of [['newer base, older incoming', cleared, finished], ['older base, newer incoming', finished, cleared]] as const) {
      const m = pair(base, inc);
      assert(m.status === 'reading', `${label}: status from the newer copy`);
      assert(m.targetFinishDate === undefined, `${label}: a removed target date stays removed`);
      assert(m.dateCompleted === undefined && m.completedAt === undefined, `${label}: a cleared finish date stays cleared`);
      assert(m.reflection === undefined, `${label}: a removed takeaway stays removed`);
    }
  }

  // 3. A newer copy with only the legacy alias (startedAt / completedAt) still gives its own date.
  {
    const older = book({ dateStarted: '2026-11-02T10:00:00.000Z', updatedAt: '2026-11-05T10:00:00.000Z' });
    const newer = book({ startedAt: '2026-11-08T10:00:00.000Z', updatedAt: '2026-11-09T10:00:00.000Z' });
    assert(pair(older, newer).dateStarted === '2026-11-08T10:00:00.000Z', 'alias of the newer copy is used');
  }

  // 4. Legacy copies without updatedAt keep the old fallback (one copy's value fills the other's gap).
  {
    const a = book({ reflection: 'Kept', targetFinishDate: '2026-11-20' });
    const b = book({ dateCompleted: '2026-11-05T10:00:00.000Z' });
    const m = pair(a, b);
    assert(m.reflection === 'Kept' && m.targetFinishDate === '2026-11-20', 'legacy: base fills the gap');
    assert(m.dateCompleted === '2026-11-05T10:00:00.000Z', 'legacy: incoming value kept');
  }

  console.log('All book merge newer-fields tests passed.');
}

run();
