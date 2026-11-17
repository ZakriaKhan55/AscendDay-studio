// A book's unitSwitches (today's and yesterday's unit switches the points rule reads) must come
// from the newer copy, and a newer copy without the key means none: switchBookUnit deletes the key
// when no switch is kept. Before the fix the `...secondary, ...primary` spread brought back the
// older copy's list whenever the newer copy had dropped the key.
import { DEFAULT_STATE, type AppState, type BookUnitSwitch, type UserBook } from '@/types';
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
const sw = (date: string, pagesBefore: number, pagesAfter: number): BookUnitSwitch =>
  ({ date, at: `${date}T10:00:00.000Z`, pagesBefore, pagesAfter, toUnit: 'chapters' }) as BookUnitSwitch;

function run() {
  console.log('Running book merge unitSwitches tests...\n');
  const oldList = [sw('2026-11-07', 40, 20)];

  // 1. The newer copy dropped the key (no switch kept): none, in both directions.
  {
    const older = book({ unitSwitches: oldList, updatedAt: '2026-11-07T10:00:00.000Z' });
    const newer = book({ updatedAt: '2026-11-09T10:00:00.000Z' });
    for (const [label, base, inc] of [['newer base, older incoming', newer, older], ['older base, newer incoming', older, newer]] as const) {
      const m = pair(base, inc);
      assert(!('unitSwitches' in m), `${label}: an absent key in the newer copy means no switches`);
    }
  }

  // 2. Both have a list: the newer copy's list, in both directions.
  {
    const newList = [sw('2026-11-09', 20, 60)];
    const older = book({ unitSwitches: oldList, updatedAt: '2026-11-07T10:00:00.000Z' });
    const newer = book({ unitSwitches: newList, updatedAt: '2026-11-09T10:00:00.000Z' });
    for (const [label, base, inc] of [['newer base, older incoming', newer, older], ['older base, newer incoming', older, newer]] as const) {
      const m = pair(base, inc);
      assert(JSON.stringify(m.unitSwitches) === JSON.stringify(newList), `${label}: the newer copy's switches`);
    }
  }

  // 3. Only the newer copy has a list: it is kept.
  {
    const older = book({ updatedAt: '2026-11-07T10:00:00.000Z' });
    const newer = book({ unitSwitches: oldList, updatedAt: '2026-11-09T10:00:00.000Z' });
    assert(JSON.stringify(pair(older, newer).unitSwitches) === JSON.stringify(oldList), 'the newer copy keeps its switches');
  }

  console.log('All book merge unitSwitches tests passed.');
}

run();
