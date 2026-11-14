// CR-06-9 (knowledge/mode-a-cr-p2-sync-2026-11-14.md): a timezone send trigger that arrives while a
// send is still running (sign-out and sign-in to another account on a slow network) is no longer
// dropped: it is sent once the running send ends, for the account signed in then.
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
};
(globalThis as { window?: unknown }).window = {
  location: { hash: '', search: '', pathname: '/' },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
};
(globalThis as { document?: unknown }).document = { visibilityState: 'visible', addEventListener: () => {} };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });

const { supabase, isSupabaseConfigured } = await import('../auth/supabase');
const { startDeviceTimezoneSync } = await import('../time/timezoneStatus');

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let signedIn = 'userA';
const sentFor: string[] = [];
let releaseA: () => void = () => {};
const auth = supabase.auth as unknown as { getSession: unknown; onAuthStateChange: unknown };
auth.getSession = async () => ({ data: { session: { user: { id: signedIn } } } });
let onAuth: (event: string) => void = () => {};
auth.onAuthStateChange = (cb: (event: string) => void) => {
  onAuth = cb;
  return { data: { subscription: { unsubscribe: () => {} } } };
};
(supabase as unknown as { from: unknown }).from = () => {
  let userId = '';
  const query = {
    update: () => query,
    eq: (_c: string, id: string) => ((userId = id), query),
    select: async () => {
      sentFor.push(userId);
      // Account A's send is slow: it waits until the test lets it finish.
      if (userId === 'userA') await new Promise<void>((resolve) => (releaseA = resolve));
      return { data: [{ id: userId }], error: null };
    },
  };
  return query;
};

assert(isSupabaseConfigured, 'runs with the fake Supabase config (hook test env)');
startDeviceTimezoneSync();
onAuth('INITIAL_SESSION');
await wait(1_200);
assert(sentFor.join() === 'userA', "account A's send started");

// Signed out and into account B while A's send still runs.
signedIn = 'userB';
onAuth('SIGNED_IN');
await wait(1_200);
assert(sentFor.join() === 'userA', 'B waits for the running send');

releaseA();
await wait(1_500);
assert(sentFor.join() === 'userA,userB', `B's timezone is sent after A's send ends (sent: ${sentFor.join()})`);

console.log('timezoneResend: all passed');
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
