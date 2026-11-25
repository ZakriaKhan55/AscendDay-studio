/**
 * AscendDay as an installed app (PWA): what this device is, whether AscendDay runs as the
 * installed app here, and a once-a-day record of that per account (app_open_days, through
 * ascend_note_app_open: supabase/migrations/20261125130000_app_open_days.sql), so active days in
 * the app and in the browser can be compared later.
 */
import { isSupabaseConfigured, supabase } from '../auth/supabase';
import { trustedNow } from '../time/clock';

export type AppPlatform = 'ios' | 'android' | 'desktop' | 'other';
export type AppDisplayMode = 'browser' | 'standalone';

// Every display mode an installed app can open in; a browser tab is 'browser'.
const APP_DISPLAY_MODES = ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'];

function userAgent(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent ?? '';
}

/** iPhone, iPod or iPad. iPadOS reports itself as a Mac with touch (no shipping Mac has touch). */
export function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = userAgent();
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** AscendDay is open as the installed app (Home Screen / app window), not in a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if ((navigator as { standalone?: boolean }).standalone === true) return true; // iOS Home Screen app
  return APP_DISPLAY_MODES.some((mode) => window.matchMedia?.(`(display-mode: ${mode})`).matches);
}

export function appPlatform(): AppPlatform {
  if (isAppleMobile()) return 'ios';
  const ua = userAgent();
  if (/Android/.test(ua)) return 'android';
  if (/Windows|Macintosh|CrOS|Linux|X11/.test(ua)) return 'desktop';
  return 'other';
}

export function appDisplayMode(): AppDisplayMode {
  return isStandalone() ? 'standalone' : 'browser';
}

// Per account: `<UTC day>|<mode>|<platform>` last recorded from this device.
const appOpenKey = (userId: string) => `ascend_app_open_${userId}`;
const appOpenInFlight = new Set<string>();

/**
 * Records once per account per UTC day per mode and platform that AscendDay was opened here. The
 * mark is written only after the server took it, so an offline start is recorded on the next one.
 * Never throws.
 */
export async function noteAppOpen(userId: string): Promise<void> {
  if (!isSupabaseConfigured || !userId) return;
  const mode = appDisplayMode();
  const platform = appPlatform();
  const mark = `${trustedNow().toISOString().slice(0, 10)}|${mode}|${platform}`;
  const key = appOpenKey(userId);
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(key);
  } catch {
    /* storage blocked: recorded on every start instead (the server keeps one row a day) */
  }
  const flight = `${key}:${mark}`;
  if (stored === mark || appOpenInFlight.has(flight)) return;
  appOpenInFlight.add(flight);
  try {
    const { error } = await supabase.rpc('ascend_note_app_open', { p_mode: mode, p_platform: platform });
    if (error) throw error;
    try {
      localStorage.setItem(key, mark);
    } catch {
      /* storage blocked: see above */
    }
  } catch (err) {
    console.warn('[install] could not record this app open:', err);
  } finally {
    appOpenInFlight.delete(flight);
  }
}
