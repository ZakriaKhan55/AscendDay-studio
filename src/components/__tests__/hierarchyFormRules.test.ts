// Goal / project / task forms (projects/HierarchyForms.tsx via projects/hierarchyFormRules.ts),
// CodeRabbit 2026-11-14:
// - CR-02-8: saving an edit keeps the item's own saved date even once it is older than the moving
//   lower bound (two years back); before, any edit rewrote it to the bound;
// - CR-02-9: a subtask typed in "Add a subtask" but not added yet is saved with the task, not dropped.
import { dateBounds, sanitizeDate, subtasksToSave } from '../projects/hierarchyFormRules';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) =>
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// The app clock falls back to the device clock until it syncs: pin it to mid-2028.
const fixedNow = new Date(2028, 5, 1, 12, 0).getTime();
Date.now = () => fixedNow;
eq(dateBounds(), { min: '2026-01-01', max: '2048-12-31' }, 'bounds: two years back to twenty ahead');

// CR-02-8
eq(sanitizeDate('2025-03-15', '2025-03-15'), '2025-03-15', 'the saved date older than the bound stays as it is');
eq(sanitizeDate(' 2025-03-15 ', '2025-03-15'), '2025-03-15', 'the saved date stays (spaces trimmed)');
eq(sanitizeDate('2025-03-15', '2025-04-01'), '2026-01-01', 'a different old date is still pulled to the bound');
eq(sanitizeDate('2025-03-15'), '2026-01-01', 'a new item with an old date is pulled to the bound');
eq(sanitizeDate('2060-01-01'), '2048-12-31', 'a far future date is pulled to the upper bound');
eq(sanitizeDate('2027-02-03', '2025-03-15'), '2027-02-03', 'a date inside the bounds is kept');
eq(sanitizeDate('', '2025-03-15'), undefined, 'a cleared field saves no date');

// CR-02-9
const subs = [{ id: 'a', title: ' Read ', completed: true }];
eq(subtasksToSave(subs, ''), [{ id: 'a', title: 'Read', completed: true }], 'no pending subtask: titles trimmed only');
eq(subtasksToSave(subs, '   '), [{ id: 'a', title: 'Read', completed: true }], 'a blank pending field adds nothing');
const withPending = subtasksToSave(subs, '  Write notes ');
eq(withPending.length, 2, 'the typed subtask is saved with the task');
eq([withPending[1].title, withPending[1].completed], ['Write notes', false], 'saved as typed (trimmed), not done');
assert(typeof withPending[1].id === 'string' && withPending[1].id.length > 0 && withPending[1].id !== 'a', 'it gets its own id');
eq(subs[0].title, ' Read ', 'the form state is not changed');

console.log('hierarchyFormRules: all assertions passed');
