// Node has no window/localStorage; the browser pieces push.ts reads are stubbed per case.
// The "Turn on notifications" card: offered until answered on this device; logout makes it
// eligible again for the next account. The install card's device record is not touched by logout.
import { disablePush, markPushPromptDone, shouldOfferPush } from '../app/push';
import { INSTALL_OFFER_KEY } from '../app/installPrompt';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

const g = globalThis as unknown as Record<string, unknown>;
const store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

/** A browser with Web Push (Android Chrome, desktop, the iOS Home Screen app), or without (iOS Safari tab). */
function browser(opts: { push: boolean; permission?: NotificationPermission }) {
  const registration = { pushManager: { getSubscription: async () => null } };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: opts.push ? { userAgent: 'test', serviceWorker: { ready: Promise.resolve(registration) } } : { userAgent: 'test' },
  });
  g.window = opts.push
    ? { isSecureContext: true, PushManager: class {}, Notification: class {} }
    : { isSecureContext: true };
  g.Notification = { permission: opts.permission ?? 'default' };
}

async function main() {
  store.clear();
  browser({ push: true });
  assert(await shouldOfferPush(), 'push works and nobody answered: offered');

  markPushPromptDone();
  assert(!(await shouldOfferPush()), 'answered: not offered again on this device');

  store.set(INSTALL_OFFER_KEY, JSON.stringify({ notNow: 2, lastAt: 5, installed: false }));
  await disablePush();
  assert(await shouldOfferPush(), 'after logout the next account is offered it again');
  assert(store.get(INSTALL_OFFER_KEY) === JSON.stringify({ notNow: 2, lastAt: 5, installed: false }), 'logout keeps the install card record (a device fact)');

  browser({ push: true, permission: 'denied' });
  assert(!(await shouldOfferPush()), 'blocked in the browser: not offered');

  // iPhone/iPad Safari tab: no Web Push, so no push card (the install card covers it instead).
  browser({ push: false });
  assert(!(await shouldOfferPush()), 'no Web Push: no push card');

  console.log('pushPrompt fixtures: all passed');
}

// An assertion that throws rejects this promise; Node then exits non-zero (unhandled rejection).
void main();
