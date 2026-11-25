// PWA install: which device this is and whether AscendDay runs as the installed app
// (knowledge/mode-a-pwa-install-2026-11-25.md). Browser pieces are stubbed per case.
import { appDisplayMode, appPlatform, isAppleMobile, isStandalone } from '../app/install';

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

console.log('installDetect: all passed');
