// useOpenFor (src/lib/ui/useOpenFor.ts), rendered in Node with the dom harness (CodeRabbit CR-02-4
// and CR-04-8, 2026-11-14): a confirm dialog opened for one focus session or one day
// - stays open while that session / day is on screen;
// - closes when it changes (the session ended or another started; the page moved to the new day at
//   midnight), so it never pops up on, or acts on, the next one;
// - stays closed when the first one comes back (no stale open state);
// - opens for nothing when there is nothing on screen.
import { doc } from '../../__tests__/harness/dom';

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { useOpenFor, useOpenForWith } = await import('../useOpenFor');

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

let api: readonly [boolean, () => void, () => void] | null = null;
const opens: boolean[] = [];
function Probe({ current }: { current: string | null | undefined }) {
  api = useOpenFor(current);
  opens.push(api[0]);
  return null;
}
const root = createRoot((doc.createElement as () => Element)());
const show = (current: string | null | undefined) => flushSync(() => root.render(React.createElement(Probe, { current })));
const open = () => api![0];

// 1. Opened for session s1: open, and it stays open while s1 is on screen.
show('s1');
eq(open(), false, 'closed at first');
flushSync(() => api![1]());
eq(open(), true, 'opened for s1');
show('s1');
eq(open(), true, 'still open while s1 shows');
flushSync(() => api![2]());
eq(open(), false, 'hide closes it');

// 2. The session ends (nothing on screen) while it is open: closed, never rendered open for nothing.
flushSync(() => api![1]());
opens.length = 0;
show(undefined);
eq(open(), false, 'session ended: closed');
assert(!opens.includes(true), 'no render shows it open with no session');

// 3. The next session starts: it does not pop up.
show('s2');
eq(open(), false, 'next session: still closed');

// 4. Day bound: opened for today, the page moves to the new day at midnight: closed; going back to
//    the first day does not bring it back.
show('2026-11-14');
flushSync(() => api![1]());
eq(open(), true, 'opened for 2026-11-14');
opens.length = 0;
show('2026-11-15');
eq(open(), false, 'new day: closed');
assert(!opens.includes(true), 'no render shows it open on the new day');
show('2026-11-14');
eq(open(), false, 'back on the first day: stays closed');

// 5. Nothing on screen: show opens nothing.
show(null);
flushSync(() => api![1]());
eq(open(), false, 'no session / day: does not open');

flushSync(() => root.unmount());

// 6. useOpenForWith (Time Tracker Delete block confirm): holds the block, bound to its day.
let withApi: readonly [string | null, (v: string | null) => void, () => void] | null = null;
const held: (string | null)[] = [];
function ProbeWith({ current }: { current: string | null | undefined }) {
  withApi = useOpenForWith<string>(current);
  held.push(withApi[0]);
  return null;
}
const root2 = createRoot((doc.createElement as () => Element)());
const showDay = (current: string | null | undefined) => flushSync(() => root2.render(React.createElement(ProbeWith, { current })));
showDay('2026-11-14');
eq(withApi![0], null, 'with: nothing at first');
flushSync(() => withApi![1]('b1'));
eq(withApi![0], 'b1', 'with: holds b1 on its day');
showDay('2026-11-14');
eq(withApi![0], 'b1', 'with: still b1 while the day shows');
flushSync(() => withApi![1](null));
eq(withApi![0], null, 'with: show(null) closes');
flushSync(() => withApi![1]('b2'));
held.length = 0;
showDay('2026-11-15');
eq(withApi![0], null, 'with: new day at midnight drops the block');
assert(!held.includes('b2'), 'with: no render holds the block on the new day');
showDay('2026-11-14');
eq(withApi![0], null, 'with: back on the first day: stays closed');
flushSync(() => withApi![1]('b3'));
flushSync(() => withApi![2]());
eq(withApi![0], null, 'with: hide closes');
showDay(null);
flushSync(() => withApi![1]('b4'));
eq(withApi![0], null, 'with: no day: does not open');
flushSync(() => root2.unmount());
console.log('useOpenFor: all checks passed');
