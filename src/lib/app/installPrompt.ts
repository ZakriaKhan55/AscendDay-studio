/**
 * The browser's install dialog (Chrome, Edge and other Chromium browsers) and this device's
 * install offer record.
 *
 * beforeinstallprompt can fire at any time, usually on page load, so it is caught from main.tsx
 * before the app renders (installInstallPromptCapture) and kept here until a tap uses it. Its
 * prompt() works once per event, so the event is dropped after use; the browser may offer a new
 * one later. preventDefault() stops Chrome's own mini-infobar on Android (our card and Settings
 * replace it; the browser menu's "Install app" stays).
 *
 * The offer record (`ascend_install_offer`) is about this device, not an account: it is kept on
 * logout and never synced (installing on a phone does nothing for a laptop).
 */
import { useSyncExternalStore } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

/** This device's answers to the install card: "Not now" taps, when the last one was, installed. */
export interface InstallOfferRecord {
  notNow: number;
  lastAt: number | null;
  installed: boolean;
}

export const INSTALL_OFFER_KEY = 'ascend_install_offer';
const EMPTY_RECORD: InstallOfferRecord = { notNow: 0, lastAt: null, installed: false };

/** The record; null when storage is blocked (the card then stays away: it could never stay closed). */
export function readInstallOffer(): InstallOfferRecord | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(INSTALL_OFFER_KEY);
  } catch {
    return null;
  }
  if (!raw) return { ...EMPTY_RECORD };
  try {
    const parsed = JSON.parse(raw) as Partial<InstallOfferRecord>;
    return {
      notNow: Number.isFinite(parsed.notNow) ? Math.max(0, Number(parsed.notNow)) : 0,
      lastAt: Number.isFinite(parsed.lastAt) ? Number(parsed.lastAt) : null,
      installed: parsed.installed === true,
    };
  } catch {
    return { ...EMPTY_RECORD };
  }
}

function writeInstallOffer(change: Partial<InstallOfferRecord>): void {
  const current = readInstallOffer();
  if (!current) return;
  try {
    localStorage.setItem(INSTALL_OFFER_KEY, JSON.stringify({ ...current, ...change }));
  } catch {
    /* storage blocked: readInstallOffer already keeps the card away */
  }
  emit();
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  listeners.forEach((listener) => listener());
}

/** Called once from main.tsx, before the app renders. */
export function installInstallPromptCapture(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    // The browser offers to install, so AscendDay is not installed (any more): an old mark goes.
    if (readInstallOffer()?.installed) writeInstallOffer({ installed: false });
    else emit();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    writeInstallOffer({ installed: true });
  });
}

export function canPromptInstall(): boolean {
  return deferredPrompt !== null;
}

/**
 * Opens the browser's install dialog (from a tap only). The event is used up either way.
 * 'unavailable' when there is no offer (used, or never fired).
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferredPrompt;
  if (!event) return 'unavailable';
  deferredPrompt = null;
  emit();
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome === 'accepted') writeInstallOffer({ installed: true });
    return outcome;
  } catch (err) {
    console.warn('[install] the install dialog failed:', err);
    return 'unavailable';
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getVersion = () => version;

/** Re-renders when the install offer arrives, is used, or the record changes. */
export function useInstallPromptVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}
