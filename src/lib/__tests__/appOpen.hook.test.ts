// PWA install, measurement: noteAppOpen records once per account per UTC day per mode and
// platform (ascend_note_app_open), retries after a failure, and never runs two calls at once.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};
let displayMode = '';
(globalThis as { window?: unknown }).window = {
  location: { hash: '', search: '', pathname: '/' },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  matchMedia: (q: string) => ({ matches: Boolean(displayMode) && q === `(display-mode: ${displayMode})` }),
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'Mozilla/5.0 (Linux; Android 10; LM-G850) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36', maxTouchPoints: 5 },
});
let deviceMs = Date.parse('2026-11-25T12:00:00Z');
Date.now = () => deviceMs;

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const { supabase, isSupabaseConfigured } = await import('../auth/supabase');
assert(isSupabaseConfigured, 'runs against the fake Supabase (hook test env)');
const calls: { fn: string; args: Record<string, unknown> }[] = [];
let failNext = false;
(supabase as unknown as { rpc: unknown }).rpc = async (fn: string, args: Record<string, unknown>) => {
  calls.push({ fn, args });
  if (failNext) {
    failNext = false;
    return { data: null, error: { message: 'offline' } };
  }
  return { data: null, error: null };
};
const { noteAppOpen } = await import('../app/install');
const U = 'user-1';
const warn = console.warn;
console.warn = () => undefined;

// Five starts the same day: one call.
for (let i = 0; i < 5; i++) await noteAppOpen(U);
assert(calls.length === 1, `5 starts same day -> 1 RPC (${calls.length})`);
assert(calls[0].fn === 'ascend_note_app_open' && calls[0].args.p_mode === 'browser' && calls[0].args.p_platform === 'android', JSON.stringify(calls[0]));

// Same day, opened as the installed app: one more.
displayMode = 'standalone';
await noteAppOpen(U);
await noteAppOpen(U);
assert(calls.length === 2 && calls[1].args.p_mode === 'standalone', `standalone recorded once (${calls.length})`);

// Next UTC day: again.
deviceMs += 24 * 60 * 60 * 1000;
await noteAppOpen(U);
assert(calls.length === 3, 'a new UTC day is recorded');

// Failure: no mark, so the next start retries.
deviceMs += 24 * 60 * 60 * 1000;
failNext = true;
await noteAppOpen(U);
assert(calls.length === 4, 'failed call made');
await noteAppOpen(U);
assert(calls.length === 5, 'retried after a failure');
await noteAppOpen(U);
assert(calls.length === 5, 'then recorded: no more calls');

// Two at once (StrictMode double effect / visibility + start): one call.
deviceMs += 24 * 60 * 60 * 1000;
await Promise.all([noteAppOpen(U), noteAppOpen(U)]);
assert(calls.length === 6, `concurrent starts -> 1 RPC (${calls.length})`);

// Another account on this device: its own record.
await noteAppOpen('user-2');
assert(calls.length === 7, 'another account is recorded on its own');

console.warn = warn;
console.log('appOpen: all passed');
