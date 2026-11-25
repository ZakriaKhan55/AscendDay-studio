// PWA install: which device this is and whether AscendDay runs as the installed app
// (knowledge/mode-a-pwa-install-2026-11-25.md). Browser pieces are stubbed per case.
import { appDisplayMode, appPlatform, installKind, installRowText, isAppleMobile, isInAppBrowser, isStandalone } from '../app/install';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const g = globalThis as unknown as Record<string, unknown>;

function browser(ua: string, opts: { touch?: number; standalone?: boolean; displayMode?: string } = {}) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: ua, maxTouchPoints: opts.touch ?? 0, standalone: opts.standalone },
  });
  g.window = { matchMedia: (q: string) => ({ matches: Boolean(opts.displayMode) && q === `(display-mode: ${opts.displayMode})` }) };
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 10; LM-G850) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const SAMSUNG = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36';
const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const WIN_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const CROS = 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Platform.
browser(IPHONE);
assert(appPlatform() === 'ios' && isAppleMobile(), 'iPhone is ios');
browser(IPAD_DESKTOP, { touch: 5 });
assert(appPlatform() === 'ios', 'iPad with a desktop-class UA (touch) is ios');
browser(IPAD_DESKTOP, { touch: 0 });
assert(appPlatform() === 'desktop' && !isAppleMobile(), 'a real Mac is desktop');
browser(ANDROID_CHROME);
assert(appPlatform() === 'android', 'Android Chrome is android (its UA also says Linux)');
browser(SAMSUNG);
assert(appPlatform() === 'android', 'Samsung Internet is android');
for (const ua of [WIN_CHROME, WIN_FIREFOX, LINUX, CROS]) {
  browser(ua);
  assert(appPlatform() === 'desktop', `desktop: ${ua.slice(13, 40)}`);
}
browser('SomeBot/1.0');
assert(appPlatform() === 'other', 'unknown UA is other');

// Display mode.
browser(ANDROID_CHROME);
assert(!isStandalone() && appDisplayMode() === 'browser', 'a tab is browser');
for (const mode of ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']) {
  browser(WIN_CHROME, { displayMode: mode });
  assert(isStandalone() && appDisplayMode() === 'standalone', `display-mode ${mode} is the installed app`);
}
browser(IPHONE, { standalone: true });
assert(appDisplayMode() === 'standalone', 'iOS Home Screen app (navigator.standalone) is standalone');
browser(IPHONE, { standalone: false });
assert(appDisplayMode() === 'browser', 'iOS Safari tab is browser');

// In-app browsers.
const INSTAGRAM_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0';
const FB_ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S911B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/121.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0;]';
const TIKTOK = 'Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 musical_ly_2023';
const WEBVIEW = 'Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36';
const GOOGLE_APP_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/350.0 Mobile/15E148 Safari/604.1';
for (const ua of [INSTAGRAM_IOS, FB_ANDROID, TIKTOK, WEBVIEW, GOOGLE_APP_IOS]) {
  browser(ua);
  assert(isInAppBrowser(), `in-app: ${ua.slice(-30)}`);
}
for (const ua of [IPHONE, ANDROID_CHROME, SAMSUNG, WIN_CHROME, WIN_FIREFOX]) {
  browser(ua);
  assert(!isInAppBrowser(), `a real browser is not in-app: ${ua.slice(-30)}`);
}

// Install kind: what Settings and the card offer.
const FIREFOX_ANDROID = 'Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0';
const MAC_SAFARI = IPAD_DESKTOP;
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const none = { canPrompt: false, installedMark: false };
const kindOf = (ua: string, input = none, opts: { touch?: number; standalone?: boolean; displayMode?: string } = {}) => {
  browser(ua, opts);
  return installKind(input);
};
assert(kindOf(ANDROID_CHROME, { canPrompt: true, installedMark: true }, { displayMode: 'standalone' }) === 'app', 'the installed app is app, whatever else');
assert(kindOf(IPHONE, none, { standalone: true }) === 'app', 'iOS Home Screen app is app');
assert(kindOf(ANDROID_CHROME, { canPrompt: true, installedMark: false }) === 'prompt', 'offer present -> prompt');
assert(kindOf(WIN_CHROME, { canPrompt: true, installedMark: true }) === 'prompt', 'an offer beats an old installed mark');
assert(kindOf(ANDROID_CHROME, { canPrompt: false, installedMark: true }) === 'installed', 'installed mark, no offer -> installed');
assert(kindOf(INSTAGRAM_IOS) === 'in-app', 'Instagram on iPhone -> in-app (before the iOS guide)');
assert(kindOf(FB_ANDROID) === 'in-app', 'Facebook on Android -> in-app');
assert(kindOf(IPHONE) === 'ios', 'iPhone Safari -> ios guide');
assert(kindOf(IPAD_DESKTOP, none, { touch: 5 }) === 'ios', 'iPad (Mac UA with touch) -> ios guide');
assert(kindOf(WIN_FIREFOX) === 'firefox-desktop', 'Firefox on Windows -> cannot install');
assert(kindOf(FIREFOX_ANDROID) === 'menu', 'Firefox on Android -> its menu');
assert(kindOf(MAC_SAFARI) === 'safari-mac', 'Safari on a Mac -> Add to Dock');
assert(kindOf(MAC_CHROME) === 'menu', 'Chrome on a Mac without an offer -> menu');
assert(kindOf(ANDROID_CHROME) === 'menu', 'Android Chrome without an offer yet -> menu');

// Settings row lines.
assert(installRowText('menu', 'android').includes('(⋮)'), 'Android menu line names the ⋮ menu');
assert(!installRowText('menu', 'desktop').includes('(⋮)'), 'desktop menu line does not');
assert(installRowText('in-app') === 'Open AscendDay in Safari or Chrome to install it.', 'in-app line');
assert(installRowText('firefox-desktop') === 'This browser can’t install apps. Chrome or Edge can.', 'Firefox line');

console.log('installDetect: all passed');
