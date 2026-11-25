// PWA install: the browser's install offer (beforeinstallprompt) is kept for one tap, used once,
// and the device's installed mark follows appinstalled / an accepted dialog / a new offer.
const store = new Map<string, string>();
let storageBlocked = false;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => {
    if (storageBlocked) throw new Error('blocked');
    return store.get(k) ?? null;
  },
  setItem: (k: string, v: string) => {
    if (storageBlocked) throw new Error('blocked');
    store.set(k, String(v));
  },
  removeItem: (k: string) => void store.delete(k),
};
const handlers = new Map<string, (event: Event) => void>();
(globalThis as { window?: unknown }).window = {
  addEventListener: (type: string, fn: (event: Event) => void) => handlers.set(type, fn),
};

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const { INSTALL_OFFER_KEY, canPromptInstall, installInstallPromptCapture, promptInstall, readInstallOffer } = await import('../app/installPrompt');

function offer(outcome: 'accepted' | 'dismissed') {
  const event = {
    prevented: false,
    prompts: 0,
    preventDefault() {
      this.prevented = true;
    },
    async prompt() {
      this.prompts += 1;
      if (this.prompts > 1) throw new Error('prompt() can only be called once');
    },
    userChoice: Promise.resolve({ outcome, platform: 'web' }),
  };
  handlers.get('beforeinstallprompt')!(event as unknown as Event);
  return event;
}

installInstallPromptCapture();
assert(handlers.has('beforeinstallprompt') && handlers.has('appinstalled'), 'both listeners installed');
assert(!canPromptInstall(), 'no offer before the event');
assert((await promptInstall()) === 'unavailable', 'no offer -> unavailable, nothing thrown');

// Offer, dismissed in the dialog: used up, nothing marked.
const first = offer('dismissed');
assert(first.prevented, "Chrome's own mini-infobar is stopped");
assert(canPromptInstall(), 'offer kept for a tap');
assert((await promptInstall()) === 'dismissed', 'dialog dismissed');
assert(first.prompts === 1 && !canPromptInstall(), 'event used once, then dropped');
assert((await promptInstall()) === 'unavailable' && first.prompts === 1, 'a second tap never calls the used event');
assert(readInstallOffer()?.installed === false, 'dismissed: not installed');

// A new offer, accepted.
offer('accepted');
assert((await promptInstall()) === 'accepted', 'dialog accepted');
assert(readInstallOffer()?.installed === true, 'accepted -> installed mark');

// Uninstalled later: the browser offers again, the old mark goes.
offer('dismissed');
assert(readInstallOffer()?.installed === false, 'a new offer clears a stale installed mark');

// Installed from the browser menu: appinstalled marks it and drops the offer.
handlers.get('appinstalled')!(new Event('appinstalled'));
assert(readInstallOffer()?.installed === true && !canPromptInstall(), 'appinstalled -> installed, offer dropped');

// The record keeps other fields and survives junk.
store.set(INSTALL_OFFER_KEY, JSON.stringify({ notNow: 2, lastAt: 123, installed: false }));
offer('dismissed');
const kept = readInstallOffer();
assert(kept?.notNow === 2 && kept.lastAt === 123, 'offer handling keeps the Not now count');
store.set(INSTALL_OFFER_KEY, '{oops');
assert(JSON.stringify(readInstallOffer()) === JSON.stringify({ notNow: 0, lastAt: null, installed: false }), 'bad JSON reads as empty');
storageBlocked = true;
assert(readInstallOffer() === null, 'storage blocked -> null (card stays away)');

console.log('installPrompt: all passed');
