// The Dashboard's one offer slot (ui/DashboardOffers.tsx), rendered on the server pass: no card
// under a boot dialog; the install card (not the push card) on a phone with an install offer;
// the right install variant per device; nothing on a computer before the push check answers.
import '../../lib/__tests__/harness/dom';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const g = globalThis as unknown as Record<string, unknown>;
const win = g.window as Record<string, unknown>;
const handlers = new Map<string, (event: Event) => void>();
const realAdd = (win.addEventListener as (t: string, fn: unknown) => void).bind(win);
win.addEventListener = (type: string, fn: (event: Event) => void) => {
  handlers.set(type, fn);
  realAdd(type, fn);
};
let displayStandalone = false;
win.matchMedia = (q: string) => ({ matches: displayStandalone && q === '(display-mode: standalone)', addEventListener() {}, removeEventListener() {} });
function device(ua: string, touch = 0) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: ua, maxTouchPoints: touch, onLine: true } });
}

const { createElement } = await import('react');
const { renderToString } = await import('react-dom/server');
const { DashboardOffers } = await import('../ui/DashboardOffers');
const { BootDialogOpenContext } = await import('../ui/bootDialogs');
const { installInstallPromptCapture, promptInstall, INSTALL_OFFER_KEY } = await import('../../lib/app/installPrompt');

const ANDROID = 'Mozilla/5.0 (Linux; Android 10; LM-G850) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const INSTAGRAM = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0';
const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const render = (bootDialogOpen = false) =>
  renderToString(createElement(BootDialogOpenContext.Provider, { value: bootDialogOpen }, createElement(DashboardOffers, { userId: 'u1' })));

installInstallPromptCapture();
handlers.get('beforeinstallprompt')!({ preventDefault() {}, prompt: async () => undefined, userChoice: Promise.resolve({ outcome: 'dismissed', platform: 'web' }) } as unknown as Event);

device(ANDROID, 5);
let html = render(true);
assert(html === '', 'boot dialog up: no card');
html = render();
assert(html.includes('Get the AscendDay app') && html.includes('Install') && html.includes('Not now'), 'Android + install offer: install card');
assert(!html.includes('Turn on'), 'never the push card with it');

displayStandalone = true;
assert(render() === '', 'installed app: no install card (push decided after its check)');
displayStandalone = false;

(g.localStorage as Storage).setItem(INSTALL_OFFER_KEY, JSON.stringify({ notNow: 3, lastAt: 0, installed: false }));
assert(render() === '', 'after 3 Not now: no install card');
(g.localStorage as Storage).removeItem(INSTALL_OFFER_KEY);

await promptInstall(); // the offer is used up (iPhone never gets one)
assert(render() === '', 'Android, offer used and no new one: no card until the next offer');
device(IPHONE);
html = render();
assert(html.includes('Get the AscendDay app') && html.includes('aria-haspopup="dialog"'), 'iPhone Safari: install card opening the guide');
assert(!html.includes('Add to Home Screen (Share'), 'the old push home-screen hint is gone');

device(INSTAGRAM);
html = render();
assert(html.includes('Open AscendDay in Safari or Chrome to install it.') && !/>Install</.test(html), 'in-app browser: open-in-browser line, no Install button');

device(WIN_CHROME);
assert(render() === '', 'computer: waits for the push check before any card');

console.log('dashboardOfferSlot: all passed');
// The harness DOM leaves handles open; end like the other render tests.
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
