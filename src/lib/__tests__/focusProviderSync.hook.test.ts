// The REAL FocusSessionProvider syncing with the server (fake Supabase env, so it talks to the
// session RPCs; this file answers them with a small fake of the SQL rules). CodeRabbit 2026-11-14:
//   CR-02-2  actions taken while each server read is in flight use up the sync's three rounds; the
//            action queued during the last read must still reach the server (sent right after that
//            sync ends), not wait in the queue with no session left to poll for.
//   CR-02-1  an account that becomes ready while another account's sync is in flight runs its own
//            sync; it is never handed the other account's (which skips it).
import { doc, installOnline } from './harness/dom';
import './harness/fakeSupabase';
import type { AppStore } from '@/lib/store/store';
import type { FocusServerRow } from '@/lib/focus/focusServerSession';

installOnline();

// --- A small fake of the session RPCs: one row per account; reads can be held. ---
type Args = Record<string, any>;
const rows = new Map<string, FocusServerRow | null>();
let account = 'u-a';
let rev = 0;
const calls: Array<{ fn: string; args: Args; account: string }> = [];
const heldReads: Array<() => void> = [];
let holdReads = false;
const iso = (t: number) => new Date(t).toISOString();

function answer(fn: string, args: Args): Record<string, unknown> {
  const row = rows.get(account) ?? null;
  const reply = (applied: boolean) => ({ row: rows.get(account) ?? null, applied, claimed: false, previous: null });
  if (fn === 'ascend_focus_session_start') {
    const s = args.p_session;
    rows.set(account, {
      session_id: s.id, status: 'running', task_name: s.taskName, skill_id: s.skillId, focus_minutes: s.focusMinutes,
      break_minutes: s.breakMinutes, is_custom: s.isCustom, started_at: iso(s.startedAt), stretch_started_at: iso(s.startTime),
      stretch_planned_seconds: s.plannedDurationSeconds, paused_at: null, paused_remaining_seconds: s.pausedRemainingSeconds,
      marks_at: [], focus_ended_at: null, end_reason: null, log_claimed: false, revision: ++rev,
    });
    return reply(true);
  }
  if (fn === 'ascend_focus_session_end') {
    if (!row || row.session_id !== args.p_session_id || row.status === 'ended') return reply(false);
    rows.set(account, { ...row, status: 'ended', end_reason: args.p_reason, focus_ended_at: args.p_at, log_claimed: true, revision: ++rev });
    return reply(true);
  }
  return reply(false); // get (and anything else): the row as it is
}

const baseFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const fn = new URL(req.url).pathname.match(/\/rest\/v1\/rpc\/(ascend_focus_session_\w+)$/)?.[1];
  if (!fn) return baseFetch(input, init);
  const text = await req.text();
  const args: Args = text ? JSON.parse(text) : {};
  const who = account;
  calls.push({ fn, args, account: who });
  if (fn === 'ascend_focus_session_get' && holdReads) await new Promise<void>((resolve) => heldReads.push(resolve));
  return new Response(JSON.stringify(answer(fn, args)), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { FocusSessionProvider, useFocusSession } = await import('../../components/pfc/FocusSessionProvider');
const S = await import('../focus/focusSession');

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
/** Waits for the next held server read and returns its release. */
async function nextRead(what: string): Promise<() => void> {
  await until(() => heldReads.length > 0, what);
  return heldReads.shift()!;
}

const storeFor = (uid: string) =>
  ({
    state: { currentUser: { id: uid }, focusLogs: [] },
    isAuthChecking: false,
    isSessionLoading: false,
    logFocusSession: () => 'focus_log',
  }) as unknown as AppStore;

let ctx: ReturnType<typeof useFocusSession> | null = null;
function Probe() {
  ctx = useFocusSession();
  return null;
}
const root = createRoot((doc.createElement as () => Element)());
const show = (uid: string) =>
  flushSync(() => root.render(React.createElement(FocusSessionProvider, { store: storeFor(uid), onOpenFocus: () => undefined, children: React.createElement(Probe) })));
const c = () => ctx!;
const startInput = (taskName: string) => ({ taskName, focusMinutes: 50, breakMinutes: 10, isCustom: false });

show('u-a');
await wait(200);

// --- CR-02-2: start, discard, start, discard, each during the read of the round before ---
holdReads = true;
flushSync(() => c().start(startInput('One')));
const s1 = c().session!.id;
let release = await nextRead('round 1 read');
flushSync(() => c().stop()); // discard One while round 1 reads
release();
release = await nextRead('round 2 read');
flushSync(() => c().start(startInput('Two')));
const s2 = c().session!.id;
release();
release = await nextRead('round 3 read');
flushSync(() => c().stop()); // discard Two while the last round reads: the session is gone, nothing polls for it
eq(c().session, null, 'no session on screen');
holdReads = false;
release();
for (const r of heldReads.splice(0)) r();
await until(() => S.readFocusOps('u-a').length === 0, 'CR-02-2: the queued discard is sent after the sync ends', 1500);
const rowA = rows.get('u-a');
eq(rowA?.session_id, s2, 'CR-02-2: server row is session Two');
eq(rowA?.status, 'ended', 'CR-02-2: session Two ended on the server');
eq(rowA?.end_reason, 'discarded', 'CR-02-2: as discarded');
assert(calls.some((x) => x.fn === 'ascend_focus_session_end' && x.args.p_session_id === s1), 'CR-02-2: discard of One was sent');
console.log('  ok  CR-02-2 an action queued during the last read still reaches the server');

// --- CR-02-1: account B becomes ready while account A's sync is in flight ---
await wait(200);
const sb: import('../focus/focusSession').FocusSession = {
  id: 'f-b', mode: 'focus', taskName: 'B work', focusMinutes: 50, breakMinutes: 10, isCustom: false,
  startTime: Date.now(), plannedDurationSeconds: 50 * 60, isPaused: false, pausedRemainingSeconds: 50 * 60,
  userId: 'u-b', startedAt: Date.now(), pausedAt: null, marksAt: [],
};
// B started a session on this device while the server could not be reached: it waits in B's queue.
localStorage.setItem(S.focusStorageKey('u-b'), JSON.stringify(sb));
S.enqueueFocusOp('u-b', { kind: 'start', sessionId: sb.id, session: sb });
holdReads = true;
flushSync(() => c().start(startInput('A again'))); // A's sync: its read is held
release = await nextRead('account A read');
account = 'u-b';
show('u-b'); // B signs in on this tab while A's read is in flight
await wait(50);
holdReads = false;
release();
for (const r of heldReads.splice(0)) r();
await until(() => rows.get('u-b')?.session_id === 'f-b', "CR-02-1: B's queued start reached the server", 1500);
eq(S.readFocusOps('u-b').length, 0, "CR-02-1: B's queue is empty");
console.log("  ok  CR-02-1 another account's sync in flight never skips this account's");

flushSync(() => root.unmount());
console.log('focusProviderSync.hook: all checks passed');
(globalThis as unknown as { process: { exit: (c: number) => never } }).process.exit(0);
