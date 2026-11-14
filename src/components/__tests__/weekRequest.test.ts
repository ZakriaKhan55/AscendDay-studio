// Weekly Goals `?week=` request (weekly/useWeekRequest.ts, used by views/WeeklyGoalsView.tsx),
// CodeRabbit CR-04-6, 2026-11-14: a request that arrives while the goal form or the delete dialog
// is open waits and opens its week once the dialog closes. Before, it was marked handled and its
// query removed at once, so closing the dialog never showed the asked-for week.
// Rendered in Node with the dom harness.
import { doc } from '../../lib/__tests__/harness/dom';

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { useWeekRequest } = await import('../weekly/useWeekRequest');

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const shown: string[] = [];
let handled = 0;
const onHandled = () => {
  handled++;
};
type Props = { requestedWeek: string | null; selectedWeekKey: string; blocked: boolean };
function Probe(p: Props) {
  useWeekRequest({ ...p, currentWeekKey: '2026-W46', onShow: (week) => shown.push(week), onHandled });
  return null;
}
const root = createRoot((doc.createElement as () => Element)());
const render = async (p: Props) => {
  flushSync(() => root.render(React.createElement(Probe, p)));
  await wait(20);
};

// 1. No dialog: the asked-for week shows once and the query is handed back.
await render({ requestedWeek: '2026-W48', selectedWeekKey: '2026-W46', blocked: false });
eq(shown, ['2026-W48'], 'no dialog: the asked-for week shows');
eq(handled, 1, 'no dialog: the request is handled once');
await render({ requestedWeek: '2026-W48', selectedWeekKey: '2026-W48', blocked: false });
eq([shown.length, handled], [1, 1], 'a re-render with the same request does nothing more');
await render({ requestedWeek: null, selectedWeekKey: '2026-W48', blocked: false });

// 2. A request while a goal dialog is open waits (week unchanged, query kept) ...
await render({ requestedWeek: '2026-W47', selectedWeekKey: '2026-W46', blocked: true });
eq([shown.length, handled], [1, 1], 'dialog open: no week change and the query stays');
await render({ requestedWeek: '2026-W47', selectedWeekKey: '2026-W46', blocked: true });
eq([shown.length, handled], [1, 1], 'still open: still waiting');
// ... and opens its week once the dialog closes.
await render({ requestedWeek: '2026-W47', selectedWeekKey: '2026-W46', blocked: false });
eq(shown, ['2026-W48', '2026-W47'], 'dialog closed: the asked-for week shows');
eq(handled, 2, 'dialog closed: the request is handled then');

// 3. A past or unreadable key opens this week; already on it, only the query goes.
await render({ requestedWeek: null, selectedWeekKey: '2026-W47', blocked: false });
await render({ requestedWeek: 'junk', selectedWeekKey: '2026-W47', blocked: false });
eq(shown[shown.length - 1], '2026-W46', 'an unreadable key opens this week');
await render({ requestedWeek: null, selectedWeekKey: '2026-W46', blocked: false });
const before = shown.length;
await render({ requestedWeek: '2026-W40', selectedWeekKey: '2026-W46', blocked: false });
eq([shown.length - before, handled], [0, 4], 'a past key while on this week: no move, query handled');

flushSync(() => root.unmount());
console.log('weekRequest: all assertions passed');
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
