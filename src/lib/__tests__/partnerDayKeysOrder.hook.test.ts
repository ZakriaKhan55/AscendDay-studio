// CR-05-12: overlapping reads of the partners' timezones (tab return, back online, pull-to-refresh)
// keep the newest answer: an older read that answers last does not replace it. Renders
// usePartnerDayKeys with react-dom in the harness DOM; supabase.rpc is replaced by held answers.
import { doc, win } from './harness/dom';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { supabase, isSupabaseConfigured } = await import('../auth/supabase');
const { APP_REFRESH_EVENT } = await import('../store/appRefresh');
const { todayKeyInZone } = await import('../time/dates');
const { trustedNow } = await import('../time/clock');
const { usePartnerDayKeys } = await import('../partners/usePartnerDayKeys');
assert(isSupabaseConfigured, 'runs with the fake Supabase settings (*.hook.test.ts)');

const PARTNER = '22222222-2222-4222-8222-222222222222';
const answers: ((timezone: string) => void)[] = [];
(supabase as unknown as { rpc: unknown }).rpc = (fn: string) => {
  assert(fn === 'ascend_partner_timezones', `reads ${fn}`);
  return new Promise((resolve) => answers.push((timezone) => resolve({ data: [{ user_id: PARTNER, timezone }], error: null })));
};

let keys: Record<string, string> = {};
function Probe() {
  keys = usePartnerDayKeys([PARTNER]);
  return null;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const root = createRoot((doc.createElement as () => Element)());
root.render(React.createElement(Probe));
await tick();
assert(answers.length === 1, 'the first read is on its way');

// A pull-to-refresh reads again while the first read is still out.
(win as unknown as { dispatchEvent(e: { type: string }): void }).dispatchEvent({ type: APP_REFRESH_EVENT });
await tick();
assert(answers.length === 2, 'the pull reads again');
// UTC+14 and UTC-11 are never on the same date, so the day key shows which answer was used.
const newestZone = 'Pacific/Kiritimati';
const olderZone = 'Pacific/Pago_Pago';
answers[1](newestZone);
await tick();
assert(keys[PARTNER] === todayKeyInZone(newestZone, trustedNow()), `the newer answer is used (${keys[PARTNER]})`);
answers[0](olderZone);
await tick();
assert(
  keys[PARTNER] === todayKeyInZone(newestZone, trustedNow()),
  `the older read answering last is dropped (${keys[PARTNER]}, older zone gives ${todayKeyInZone(olderZone, trustedNow())})`
);

root.unmount();
console.log('partnerDayKeysOrder: all passed');
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0); // the Supabase client keeps timers alive
