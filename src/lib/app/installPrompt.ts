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
import { trustedNowMs } from '../time/clock';
import type { AppPlatform, InstallKind } from './install';

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

// The Dashboard's install card: each "Not now" uses one offer and snoozes it for a week. Phones
// and tablets get 3 offers; a computer 1 (its browser shows an install icon anyway and push works
// there without installing).
export const INSTALL_OFFER_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
export const INSTALL_OFFERS_MOBILE = 3;
export const INSTALL_OFFERS_DESKTOP = 1;

const isComputer = (platform: AppPlatform) => platform === 'desktop' || platform === 'other';

/**
 * Whether the install card is due on this device: not installed (record), something to offer
 * (a computer only with the browser's install dialog; a phone also with the iPhone guide or the
 * in-app browser line), offers left, and a week past the last "Not now". Storage blocked (null
 * record) = never, so a closed card can never come straight back.
 */
export function installOfferDue({
  record,
  kind,
  platform,
  nowMs,
}: {
  record: InstallOfferRecord | null;
  kind: InstallKind;
  platform: AppPlatform;
  nowMs: number;
}): boolean {
  if (!record || record.installed) return false;
  const computer = isComputer(platform);
  if (computer ? kind !== 'prompt' : kind !== 'prompt' && kind !== 'ios' && kind !== 'in-app') return false;
  if (record.notNow >= (computer ? INSTALL_OFFERS_DESKTOP : INSTALL_OFFERS_MOBILE)) return false;
  return record.lastAt === null || nowMs - record.lastAt >= INSTALL_OFFER_SNOOZE_MS;
}

/** One more "Not now" on the install card (also its install dialog's Cancel, and Got it in its iPhone guide). */
export function markInstallNotNow(): void {
  const current = readInstallOffer();
  if (!current) return;
  writeInstallOffer({ notNow: current.notNow + 1, lastAt: trustedNowMs() });
}

export type OfferSlot = 'install' | 'push' | null;

/**
 * The Dashboard shows one offer card at a time. A phone or tablet offers install first (on iPhone
 * push needs the installed app; on Android the app is the better home for reminders); a computer
 * offers push first and install later. `pushDue` null = still being checked. Once either card is
 * answered, the other waits for the next app start (offerAnsweredThisLoad).
 */
export function pickOfferSlot({
  platform,
  installDue,
  pushDue,
}: {
  platform: AppPlatform;
  installDue: boolean;
  pushDue: boolean | null;
}): OfferSlot {
  if (isComputer(platform)) {
    if (pushDue === null) return null;
    return pushDue ? 'push' : installDue ? 'install' : null;
  }
  if (installDue) return 'install';
  return pushDue ? 'push' : null;
}

// Page-load scoped: set when the install or push card is answered, so the other one waits for the
// next app start instead of popping up right after.
let offerAnswered = false;

export function offerAnsweredThisLoad(): boolean {
  return offerAnswered;
}

export function markOfferAnsweredThisLoad(): void {
  offerAnswered = true;
}
