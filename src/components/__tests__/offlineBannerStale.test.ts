// CR-03-7: a server check that was on its way when the device went offline does not flip the
// banner back to "online/restored" when its answer lands afterwards; a check started after coming
// back online still shows "restored". Renders useConnectionStatus with react-dom in the harness DOM.
import { doc, installOnline, setOnline } from '../../lib/__tests__/harness/dom';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

installOnline();
const pending: ((ok: boolean) => void)[] = [];
(globalThis as unknown as Record<string, unknown>).fetch = () =>
  new Promise((resolve) => pending.push((ok) => resolve({ ok, status: ok ? 200 : 503 })));

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useConnectionStatus } = await import('../ui/OfflineBanner');

const seen: string[] = [];
function Probe() {
  const status = useConnectionStatus();
  if (seen[seen.length - 1] !== status) seen.push(status);
  return null;
}
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const status = () => seen[seen.length - 1];

const root = createRoot((doc.createElement as () => Element)());
root.render(React.createElement(Probe));
await tick();
assert(pending.length === 1, `the first check is on its way (${pending.length})`);

// The device drops off the network while that check is still out.
setOnline(false);
await tick();
assert(status() === 'offline', `offline shows at once (${seen.join(', ')})`);
// The old check's server answer lands now: it no longer describes the connection.
pending.shift()!(true);
await tick(50);
assert(status() === 'offline', `a check answered after going offline does not show online (${seen.join(', ')})`);

// Back online: a fresh check runs and its answer shows "restored".
setOnline(true);
await tick();
assert(pending.length === 1, `back online starts a fresh check (${pending.length})`);
pending.shift()!(true);
await tick(50);
assert(status() === 'restored', `a check started after coming back shows restored (${seen.join(', ')})`);

root.unmount();
console.log('offlineBannerStale: all passed');
process.exit(0); // the 4 s "restored" timer is not waited for
