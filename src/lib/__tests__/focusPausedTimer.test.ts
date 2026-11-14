// A paused focus session (logout pause) through the REAL FocusSessionProvider, rendered in Node (no
// Supabase env = device-only mode). CodeRabbit CR-02-3 (2026-11-14): each time the page comes back
// into view the resume-deadline check re-arms its timer; it must replace the waiting one, so there is
// only ever one, and none is left running after the provider unmounts.
import { doc, win } from './harness/dom';
import type { AppStore } from '@/lib/store/store';

// Every timer the page starts, so the test can count the ones still waiting.
const pending = new Map<unknown, number>();
const baseSet = globalThis.setTimeout;
const baseClear = globalThis.clearTimeout;
const trackedSet = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
  const id: unknown = baseSet(
    (...a: unknown[]) => {
      pending.delete(id);
      fn(...a);
    },
    ms,
    ...rest
  );
  pending.set(id, ms ?? 0);
  return id;
}) as unknown as typeof setTimeout;
const trackedClear = ((id: unknown) => {
  pending.delete(id);
  baseClear(id as Parameters<typeof clearTimeout>[0]);
}) as typeof clearTimeout;
globalThis.setTimeout = trackedSet;
globalThis.clearTimeout = trackedClear;
win.setTimeout = trackedSet;
win.clearTimeout = trackedClear;

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { FocusSessionProvider, useFocusSession } = await import('../../components/pfc/FocusSessionProvider');
const S = await import('../focus/focusSession');
const { trustedNowMs } = await import('../time/clock');

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const wait = (ms: number) => new Promise((resolve) => baseSet(resolve, ms));
/** Polls (the machine may be slow): fails with `what` after `ms`. */
async function until(pred: () => unknown, what: string, ms = 5000) {
  for (let waited = 0; !pred(); waited += 20) {
    if (waited > ms) throw new Error(`Assertion failed: timed out waiting for ${what}`);
    await wait(20);
  }
}
const UID = 'u-paused';
const KEY = S.focusStorageKey(UID);
/** The paused-session check waits at most a minute at a time (MAX_WAIT_MS); its deadline is 30 min away. */
const deadlineChecks = () => [...pending.values()].filter((ms) => ms === 60_000).length;

const store = {
  state: { currentUser: { id: UID }, focusLogs: [] },
  isAuthChecking: false,
  isSessionLoading: false,
  logFocusSession: () => 'focus_log',
} as unknown as AppStore;

let ctx: ReturnType<typeof useFocusSession> | null = null;
function Probe() {
  ctx = useFocusSession();
  return null;
}
const root = createRoot((doc.createElement as () => Element)());
root.render(React.createElement(FocusSessionProvider, { store, onOpenFocus: () => undefined, children: React.createElement(Probe) }));
await until(() => ctx, 'provider rendered');

// A session paused by a logout a moment ago (another tab wrote it): resumable for 30 minutes.
const now = trustedNowMs();
const paused: import('../focus/focusSession').FocusSession = {
  id: 'f-paused', mode: 'focus', taskName: 'Write', focusMinutes: 50, breakMinutes: 10, isCustom: false,
  startTime: now - 10 * 60_000, plannedDurationSeconds: 50 * 60, isPaused: true, pausedRemainingSeconds: 40 * 60,
  userId: UID, startedAt: now - 10 * 60_000, pausedAt: now, marksAt: [],
};
localStorage.setItem(KEY, JSON.stringify(paused));
(win as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent({ type: 'storage', key: KEY, newValue: JSON.stringify(paused) });
await until(() => ctx!.session?.isPaused, 'paused session on screen');
await until(() => deadlineChecks() > 0, 'deadline check armed');
await wait(200);
eq(deadlineChecks(), 1, 'one deadline check waiting');

// The page comes back into view three times before the minute is up.
for (let i = 0; i < 3; i++) {
  (doc as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent({ type: 'visibilitychange' });
  await wait(50);
}
await wait(300);
eq(deadlineChecks(), 1, 'still one deadline check after the page came back three times');

root.unmount();
await wait(300);
eq(deadlineChecks(), 0, 'no deadline check left after unmount');

console.log('focusPausedTimer: all checks passed');
