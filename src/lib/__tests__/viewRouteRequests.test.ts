// A page asked for twice while its code loads, with another page asked for in between
// (app/useViewRoute.ts, CodeRabbit CR-04-20, 2026-11-14): Settings ?section=account, then Habits,
// then Settings ?section=notifications. Before, the first Settings request finished first, saw
// Settings as the latest target and committed its own old address (?section=account); the latest
// request then found Settings already shown and stopped. Now each request has its own number and
// only the latest one shows the page with its address.
// Rendered in Node with the dom harness and a small fake history.
import { doc, win } from './harness/dom';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const g = globalThis as unknown as Record<string, unknown>;
const location = new URL('http://localhost/dashboard');
const go = (url: string) => {
  location.href = new URL(url, location.href).href;
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

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { useViewRoute } = await import('../app/useViewRoute');
type View = Parameters<ReturnType<typeof useViewRoute>['navigate']>[0];

// A page's code loads once (like a dynamic import): every request for it waits on the same load.
const loads = new Map<string, { promise: Promise<void>; resolve: () => void }>();
const load = (view: string) => {
  let entry = loads.get(view);
  if (!entry) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    entry = { promise, resolve };
    loads.set(view, entry);
  }
  return entry;
};
const prepare = (view: View) => load(view).promise;

let route: ReturnType<typeof useViewRoute> | null = null;
function Probe() {
  route = useViewRoute(prepare);
  return null;
}
const root = createRoot((doc.createElement as () => Element)());
flushSync(() => root.render(React.createElement(Probe)));
await wait(20);
eq(route!.view, 'dashboard', 'starts on the dashboard');

// Settings (account), Habits, Settings (notifications), all while Settings' code is loading.
flushSync(() => route!.navigate('settings' as View, '?section=account'));
flushSync(() => route!.navigate('habits' as View));
flushSync(() => route!.navigate('settings' as View, '?section=notifications'));
await wait(20);
eq(route!.view, 'dashboard', 'nothing shows before the code is loaded');

load('settings').resolve();
await wait(50);
load('habits').resolve();
await wait(50);
eq(route!.view, 'settings', 'Settings shows');
eq(location.pathname + location.search, '/settings?section=notifications', 'the address is the latest request (notifications)');
eq(route!.search, '?section=notifications', 'the page gets the latest query');

flushSync(() => root.unmount());
console.log('viewRouteRequests: all assertions passed');
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
