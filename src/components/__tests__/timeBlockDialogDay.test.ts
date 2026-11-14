// The Time Tracker block dialog stays bound to the day it was opened for (CodeRabbit CR-04-5,
// 2026-11-14): at midnight the page moves from the old today to the new one, and a dialog still open
// must not save its draft onto the new day. Source check of TimeTrackerView.tsx (the page needs the
// whole app to render): the day is captured when the dialog opens and is the one the dialog shows,
// checks against and saves to. The store side (a past day refuses the save with "Past days can't
// change.") is the existing addDailyTimeBlock / updateDailyTimeBlock guard.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const src = readFileSync(fileURLToPath(new URL('../views/TimeTrackerView.tsx', import.meta.url)), 'utf8');
const body = (name: string) => {
  const start = src.indexOf(`const ${name} = (`);
  assert(start !== -1, `${name} exists`);
  return src.slice(start, src.indexOf('\n  };', start));
};

assert(/const \[blockDateKey, setBlockDateKey\] = useState\(selectedDateKey\)/.test(src), 'the dialog day is its own state');
assert(body('openAddBlock').includes('setBlockDateKey(selectedDateKey)'), 'Add block captures the day on screen');
assert(body('openEditBlock').includes('setBlockDateKey(selectedDateKey)'), 'Edit block captures the day on screen');
const save = body('saveBlock');
assert(save.includes('store.updateDailyTimeBlock(blockDateKey,'), 'an edit saves to the captured day');
assert(save.includes('store.addDailyTimeBlock(blockDateKey,'), 'a new block saves to the captured day');
assert(!save.includes('selectedDateKey'), 'saving never reads the day on screen');
assert(/context=\{\{ kind: 'day', dateKey: blockDateKey, dayBlocks: blockDayBlocks, nextDayBlocks \}\}/.test(src), 'the dialog shows and checks the captured day');
assert(/addDays\(blockDateKey, 1\)/.test(src), 'the next-day overlap check follows the captured day');

console.log('timeBlockDialogDay: all checks passed');
