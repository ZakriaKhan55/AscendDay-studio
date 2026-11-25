// PWA install card rules (knowledge/mode-a-pwa-install-2026-11-25.md §3): a week between offers,
// 3 offers on a phone/tablet and 1 on a computer, never once installed or with storage blocked,
// and one Dashboard card at a time (install first on phones, push first on computers).
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};
(globalThis as { window?: unknown }).window = { addEventListener: () => undefined };

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const {
  INSTALL_OFFER_KEY,
  INSTALL_OFFER_SNOOZE_MS,
  installOfferDue,
  markInstallNotNow,
  markOfferAnsweredThisLoad,
  offerAnsweredThisLoad,
  pickOfferSlot,
  readInstallOffer,
} = await import('../app/installPrompt');
const { trustedNowMs } = await import('../time/clock');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-25T12:00:00Z');
const rec = (notNow: number, lastAt: number | null, installed = false) => ({ notNow, lastAt, installed });
const due = (record: ReturnType<typeof rec> | null, kind: Parameters<typeof installOfferDue>[0]['kind'], platform: Parameters<typeof installOfferDue>[0]['platform'], nowMs = NOW) =>
  installOfferDue({ record, kind, platform, nowMs });

assert(INSTALL_OFFER_SNOOZE_MS === 7 * DAY, 'snooze is 7 days');

// First offer.
assert(due(rec(0, null), 'prompt', 'android'), 'Android with the install dialog: due');
assert(due(rec(0, null), 'ios', 'ios'), 'iPhone Safari: due (guide)');
assert(due(rec(0, null), 'in-app', 'android'), 'in-app browser on a phone: due (open-in-browser line)');
assert(!due(rec(0, null), 'menu', 'android'), 'Android without the dialog yet: waits');
assert(!due(rec(0, null), 'app', 'android'), 'the installed app: never');
assert(!due(rec(0, null), 'installed', 'android'), 'installed mark: never');
assert(!due(rec(0, null, true), 'prompt', 'android'), 'record says installed: never');
assert(!due(null, 'prompt', 'android'), 'storage blocked: never');

// Snooze.
assert(!due(rec(1, NOW - 6.99 * DAY), 'prompt', 'android'), 'day 6.99 after Not now: hidden');
assert(due(rec(1, NOW - 7 * DAY), 'prompt', 'android'), 'day 7: back');
assert(!due(rec(1, NOW + DAY), 'prompt', 'android'), 'a Not now stamped in the future (clock moved) stays hidden until then');

// Cap: 3 on phones, 1 on computers, even with lastAt long ago.
assert(due(rec(2, NOW - 30 * DAY), 'ios', 'ios'), '3rd offer still allowed after 2 Not now');
assert(!due(rec(3, NOW - 365 * DAY), 'ios', 'ios'), 'after the 3rd Not now: never again');
assert(!due(rec(3, null), 'prompt', 'android'), 'cap holds without a date too');

// Computers: browser dialog only, 1 offer.
assert(due(rec(0, null), 'prompt', 'desktop'), 'desktop Chrome with the dialog: due');
assert(!due(rec(1, NOW - 365 * DAY), 'prompt', 'desktop'), 'desktop: 1 offer only');
assert(!due(rec(0, null), 'firefox-desktop', 'desktop'), 'Firefox desktop: no card');
assert(!due(rec(0, null), 'safari-mac', 'desktop'), 'Safari Mac: no card');
assert(!due(rec(0, null), 'in-app', 'desktop'), 'desktop in-app: no card');
assert(!due(rec(1, null), 'prompt', 'other'), 'unknown platform follows the computer cap');

// Not now: counts and stamps the trusted time; keeps the installed flag.
store.clear();
markInstallNotNow();
const one = readInstallOffer()!;
assert(one.notNow === 1 && one.lastAt !== null && Math.abs(one.lastAt - trustedNowMs()) < 5000, `Not now #1 stamped (${JSON.stringify(one)})`);
markInstallNotNow();
markInstallNotNow();
assert(readInstallOffer()!.notNow === 3, 'three Not now');
assert(!installOfferDue({ record: readInstallOffer(), kind: 'prompt', platform: 'android', nowMs: trustedNowMs() + 365 * DAY }), '3 Not now: never again');
assert(JSON.parse(store.get(INSTALL_OFFER_KEY)!).installed === false, 'record keeps installed=false');

// One slot.
const slot = (platform: 'android' | 'ios' | 'desktop' | 'other', installDue: boolean, pushDue: boolean | null) => pickOfferSlot({ platform, installDue, pushDue });
assert(slot('android', true, true) === 'install', 'phone: install first, never both');
assert(slot('android', true, null) === 'install', 'phone: install does not wait for the push check');
assert(slot('android', false, true) === 'push', 'phone without install offer: push as before');
assert(slot('ios', false, false) === null, 'nothing due: nothing');
assert(slot('desktop', true, true) === 'push', 'computer: push first');
assert(slot('desktop', true, null) === null, 'computer: waits for the push check');
assert(slot('desktop', true, false) === 'install', 'computer: install once push is answered / not offered');
assert(slot('other', true, true) === 'push', 'unknown platform: computer order');
for (const p of ['android', 'ios', 'desktop', 'other'] as const)
  for (const i of [true, false])
    for (const d of [true, false, null]) {
      const s = slot(p, i, d);
      assert(s === null || s === 'install' || s === 'push', 'a single slot value');
      assert(s !== 'install' || i, 'install only when due');
      assert(s !== 'push' || d === true, 'push only when due');
    }

// Answered this page load.
assert(!offerAnsweredThisLoad(), 'nothing answered yet');
markOfferAnsweredThisLoad();
assert(offerAnsweredThisLoad(), 'answered: the other card waits for the next start');

console.log('installOffer: all passed');
