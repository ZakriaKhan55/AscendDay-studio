// Browser Back/Forward onto a sign-in or legal page while a form has unsaved typing
// (app/useViewRoute.ts, CodeRabbit CR-04-21, 2026-11-14). Before, that move skipped the
// "Discard changes?" question: the app shell unmounted and the typing was lost. Now it asks first,
// like a move between app pages: "Keep editing" stays put (address put back), "Discard" goes.
// Rendered in Node with the dom harness and a small fake history.
import { doc, win } from './harness/dom';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A location the app can read and history calls can move; popstate is fired by hand like a browser.
const g = globalThis as unknown as Record<string, unknown>;
const location = new URL('http://localhost/habits');
const go = (url: string) => {
  const next = new URL(url, location.href);
  location.href = next.href;
};
const history = {
  state: null as unknown,
  scrollRestoration: 'auto',
  pushState: (_s: unknown, _t: string, url?: string) => url !== undefined && go(url),
  replaceState: (_s: unknown, _t: string, url?: string) => url !== undefined && go(url),
};
win.location = location;
win.history = history;
g.location = location;
g.history = history;
/** Browser Back/Forward: the address has already moved when popstate fires. */
const browserMove = (path: string) => {
  go(path);
  (win as unknown as { dispatchEvent: (e: { type: string }) => void }).dispatchEvent({ type: 'popstate' });
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { useViewRoute } = await import('../app/useViewRoute');
const { useUnsavedChanges, useDiscardRequest } = await import('../ui/unsavedChanges');

let route: ReturnType<typeof useViewRoute> | null = null;
let discardRequest: ReturnType<typeof useDiscardRequest> | null = null;
function Probe({ text }: { text: string }) {
  route = useViewRoute();
  discardRequest = useDiscardRequest();
  useUnsavedChanges(true, text);
  return null;
}
const root = createRoot((doc.createElement as () => Element)());
const render = async (text: string) => {
  flushSync(() => root.render(React.createElement(Probe, { text })));
  await wait(20);
};
const firstAction = () => (doc as unknown as { dispatchEvent: (e: { type: string }) => void }).dispatchEvent({ type: 'keydown' });

// 1. Clean form: Forward to the sign-up page goes at once.
await render('');
eq(route!.view, 'habits', 'starts on Habits');
browserMove('/signup');
await wait(20);
eq(route!.auth, 'signup', 'clean: moves to the sign-up page at once');
eq(discardRequest!.open, false, 'clean: no question');
browserMove('/habits');
await wait(20);
eq(route!.auth, null, 'clean: Back to Habits from the sign-up page');

// 2. Unsaved typing, then Forward to the sign-up page: asks first and stays on Habits.
firstAction();
await render('typed text');
browserMove('/signup');
await wait(20);
eq(discardRequest!.open, true, 'dirty: "Discard changes?" is asked');
eq(route!.auth, null, 'dirty: still on the app page while asked');
eq(location.pathname, '/habits', 'dirty: the address is put back to Habits');

// 3. Keep editing: stays.
flushSync(() => discardRequest!.keepEditing());
await wait(20);
eq(route!.auth, null, 'Keep editing: stays on Habits');
eq(location.pathname, '/habits', 'Keep editing: address stays on Habits');

// 4. The same with a legal page, then Discard: goes to it.
browserMove('/privacy');
await wait(20);
eq(discardRequest!.open, true, 'dirty: asked before the Privacy Policy too');
eq(route!.legal, null, 'dirty: Privacy not shown while asked');
flushSync(() => discardRequest!.discard());
await wait(20);
eq(route!.legal, 'privacy', 'Discard: the Privacy Policy shows');
eq(location.pathname, '/privacy', 'Discard: the address is the Privacy Policy');

flushSync(() => root.unmount());
console.log('viewRouteUnsaved: all assertions passed');
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
