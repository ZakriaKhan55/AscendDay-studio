// The REAL FocusSessionProvider adopting a session started offline that is on a break when this
// device first reaches the server (no start waiting in the queue, so reconcile uploads the local copy).
// Gap 2026-11-17: the upload had no break end, so the server made it a plain pause (30-min window
// instead of break end + 10 min) and did not count the break toward the max of 2. The start now sends
// pauseEndsAt + breakCount (20261117170000_focus_start_keeps_break.sql keeps them; PGlite-tested in
// work/gap-focus/pglite-test.mjs). The fake below answers start the way that SQL does.
import { doc, installOnline } from './harness/dom';
import './harness/fakeSupabase';
import type { AppStore } from '@/lib/store/store';
import type { FocusServerRow } from '@/lib/focus/focusServerSession';

installOnline();

type Args = Record<string, any>;
let row: FocusServerRow | null = null;
let rev = 0;
const calls: Array<{ fn: string; args: Args }> = [];
const iso = (t: number | null | undefined) => (typeof t === 'number' ? new Date(t).toISOString() : null);

function answer(fn: string, args: Args): Record<string, unknown> {
  const reply = (applied: boolean) => ({ row, applied, claimed: false, previous: null });
  if (fn === 'ascend_focus_session_start') {
    const s = args.p_session;
    if (row && row.session_id === s.id) return reply(true);
    const onBreak = s.isPaused && typeof s.pauseEndsAt === 'number';
    row = {
      session_id: s.id, status: s.isPaused ? 'paused' : 'running', task_name: s.taskName, skill_id: s.skillId,
      focus_minutes: s.focusMinutes, break_minutes: s.breakMinutes, is_custom: s.isCustom, started_at: iso(s.startedAt)!,
      stretch_started_at: iso(s.startTime)!, stretch_planned_seconds: s.plannedDurationSeconds,
      paused_at: s.isPaused ? iso(s.pausedAt) : null, paused_remaining_seconds: s.pausedRemainingSeconds,
      marks_at: [], focus_ended_at: null, end_reason: null, log_claimed: false, revision: ++rev,
      pause_ends_at: onBreak ? iso(s.pauseEndsAt) : null,
      break_count: Math.min(2, Math.max(onBreak ? 1 : 0, Number(s.breakCount) || 0)),
    };
    return reply(true);
  }
  return reply(false); // get: the row as it is
}

const baseFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const fn = new URL(req.url).pathname.match(/\/rest\/v1\/rpc\/(ascend_focus_session_\w+)$/)?.[1];
  if (!fn) return baseFetch(input, init);
  const text = await req.text();
  const args: Args = text ? JSON.parse(text) : {};
  calls.push({ fn, args });
  return new Response(JSON.stringify(answer(fn, args)), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { FocusSessionProvider, useFocusSession } = await import('../../components/pfc/FocusSessionProvider');
const S = await import('../focus/focusSession');
const { trustedNowMs } = await import('../time/clock');

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(pred: () => unknown, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`Assertion failed: timed out waiting for ${what}`);
    await wait(10);
  }
}

const MIN = 60_000;
const UID = 'u-adopt';
const now = trustedNowMs();
// Started offline 30 min ago (50 min planned); a 10-min break after 26 focused min, 4 min ago.
const offline: import('../focus/focusSession').FocusSession = {
  id: 'f-off', mode: 'focus', taskName: 'Offline work', focusMinutes: 50, breakMinutes: 10, isCustom: false,
  startTime: now - 30 * MIN, plannedDurationSeconds: 50 * 60, isPaused: false, pausedRemainingSeconds: 50 * 60,
  userId: UID, startedAt: now - 30 * MIN, pausedAt: null, marksAt: [],
};
const onBreak = S.breakAt(offline, now - 4 * MIN, 10);
assert(S.onBreak(onBreak) && onBreak.revision === undefined, 'fixture: unconfirmed, on a break');
// Stored on this device, nothing queued (the start was lost / never queued): reconcile must adopt it.
localStorage.setItem(S.focusStorageKey(UID), JSON.stringify(onBreak));
eq(S.readFocusOps(UID).length, 0, 'fixture: empty queue');

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
flushSync(() => root.render(React.createElement(FocusSessionProvider, { store, onOpenFocus: () => undefined, children: React.createElement(Probe) })));

await until(() => calls.some((x) => x.fn === 'ascend_focus_session_start'), 'the adopt upload');
const sent = calls.find((x) => x.fn === 'ascend_focus_session_start')!.args.p_session;
eq(sent.id, 'f-off', 'adopt: uploads the local session');
eq(sent.isPaused, true, 'adopt: paused');
eq(sent.pausedAt, onBreak.pausedAt, 'adopt: pausedAt = break start');
eq(sent.pauseEndsAt, onBreak.pausedAt! + 10 * MIN, 'adopt: pauseEndsAt = break start + 10 min (was missing: plain pause)');
eq(sent.breakCount, 1, 'adopt: the offline break is counted');

await until(() => ctx?.session?.revision !== undefined, 'the session follows the server row');
const shown = ctx!.session!;
assert(S.onBreak(shown), 'after adopt: still on its break (not a plain pause)');
eq(shown.pauseEndsAt, onBreak.pauseEndsAt, 'after adopt: same break end');
eq(S.resumeDeadlineMs(shown), onBreak.pauseEndsAt! + S.FOCUS_BREAK_GRACE_MS, 'after adopt: Continue until break end + 10 min (not pause + 30)');
eq(shown.breakCount, 1, 'after adopt: server-counted break count 1');
eq((row as FocusServerRow | null)?.break_count, 1, 'server row: break_count 1');
eq(S.readFocusOps(UID).length, 0, 'queue empty');
console.log('  ok  an offline session adopted on a break keeps its break and its count');

flushSync(() => root.unmount());
console.log('focusAdoptBreak.hook: all checks passed');
(globalThis as unknown as { process: { exit: (c: number) => never } }).process.exit(0);
