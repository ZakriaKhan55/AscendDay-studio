// CR-06-7 (knowledge/mode-a-cr-p2-sync-2026-11-14.md): offline, a device clock moved forward looks
// like a sleep and the trusted time follows it (documented trade-off), but that caught-up time is no
// longer stored as the last trusted time, so it cannot become the floor of the next offline start.
// A server read stores its time as before. Real clock.ts module state, fake timers and server.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};
const listeners = new Map<string, Array<() => void>>();
const listen = (type: string, fn: () => void) => listeners.set(type, [...(listeners.get(type) || []), fn]);
const fire = (type: string) => (listeners.get(type) || []).forEach((fn) => fn());
(globalThis as { window?: unknown }).window = {
  location: { hash: '', search: '', pathname: '/' },
  addEventListener: listen,
  removeEventListener: () => {},
  dispatchEvent: () => true,
  setInterval: () => 0,
};
(globalThis as { document?: unknown }).document = { visibilityState: 'visible', addEventListener: listen };
let online = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { get onLine() { return online; } } });

const DAY = 24 * 60 * 60 * 1000;
const SERVER = Date.parse('2026-11-14T10:00:00.000Z');
let perfMs = 1_000;
let deviceMs = SERVER;
let serverMs = SERVER;
Object.defineProperty(performance, 'now', { configurable: true, value: () => perfMs });
Date.now = () => deviceMs;

const { supabase, isSupabaseConfigured } = await import('../auth/supabase');
(supabase as unknown as { rpc: unknown }).rpc = async () => ({ data: new Date(serverMs).toISOString(), error: null });
const { startTrustedClock, clockReady, syncClock, trustedNowMs } = await import('../time/clock');

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const stored = () => Number(store.get('ascend_last_trusted_ms'));

assert(isSupabaseConfigured, 'runs with the fake Supabase config (hook test env)');
startTrustedClock();
await clockReady();
assert(trustedNowMs() === SERVER, 'the server time is used');
assert(stored() === SERVER, 'a server read is stored');

// Offline, the device clock is moved forward a day (1 s of real time passes).
online = false;
perfMs = 2_000;
deviceMs = SERVER + DAY + 1_000;
assert(trustedNowMs() === SERVER + DAY + 1_000, 'the trusted time follows the forward jump offline (looks like a sleep)');
fire('pagehide');
assert(stored() === SERVER, `the caught-up time is not stored (stored ${new Date(stored()).toISOString()})`);
// The tab is hidden: still not stored.
(document as unknown as { visibilityState: string }).visibilityState = 'hidden';
fire('visibilitychange');
assert(stored() === SERVER, 'hiding the tab does not store it either');

// Back online, the server read corrects the time and is stored again.
online = true;
perfMs = 3_000;
serverMs = SERVER + 2_000;
await syncClock();
assert(trustedNowMs() === SERVER + 2_000, 'the server read corrects the time');
assert(stored() === SERVER + 2_000, 'the confirmed time is stored');
perfMs = 4_000;
fire('pagehide');
assert(stored() === SERVER + 3_000, 'later stores follow the confirmed time');

// Offline again, the clock jumps forward and the page is hidden before anything reads the time:
// the store itself notices the jump and does not keep it.
online = false;
perfMs = 5_000;
deviceMs += DAY + 1_000;
fire('pagehide');
assert(stored() === SERVER + 3_000, 'a jump first noticed by the store is not stored');

console.log('clockRemember: all passed');
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
