// CR-02-11: the Settings push switch shows the newest truth. A push-state read that finishes after
// the toggle changed push, or after a newer read (account change, tab return), is dropped.
// Renders usePushStatus with react-dom in the harness DOM, with a controllable read.
import { doc } from '../../lib/__tests__/harness/dom';
import type { PushStatus } from '../../lib/app/push';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { usePushStatus } = await import('../settings/usePushStatus');

const reads: { userId?: string; answer: (status: PushStatus) => void }[] = [];
const read = (userId?: string) => new Promise<PushStatus>((resolve) => reads.push({ userId, answer: resolve }));

let hook: ReturnType<typeof usePushStatus> | null = null;
function Probe({ userId }: { userId: string }) {
  hook = usePushStatus(userId, read);
  const { readPushStatus } = hook;
  React.useEffect(() => readPushStatus('off'), [readPushStatus]);
  return null;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const root = createRoot((doc.createElement as () => Element)());

// P1: the first read is still out when the user turns push on; it answers "off" afterwards.
root.render(React.createElement(Probe, { userId: 'user-a' }));
await tick();
assert(reads.length === 1, 'P1: first read started');
hook!.setPushStatus('on');
await tick();
reads[0].answer('off');
await tick();
assert(hook!.pushStatus === 'on', `P1: a read begun before the toggle does not flip the switch back (${hook!.pushStatus})`);

// P2: account change: the new account's read answers first, the old account's read last.
root.render(React.createElement(Probe, { userId: 'user-b' }));
await tick();
assert(reads.length === 2 && reads[1].userId === 'user-b', 'P2: the new account is read');
hook!.readPushStatus(); // and a tab return reads again
await tick();
const [, oldRead, newest] = reads;
newest.answer('off');
await tick();
oldRead.answer('on');
await tick();
assert(hook!.pushStatus === 'off', `P2: an older read answering last is dropped (${hook!.pushStatus})`);

// The newest read is shown.
hook!.readPushStatus();
await tick();
reads[3].answer('denied');
await tick();
assert(hook!.pushStatus === 'denied', 'the newest read is shown');

root.unmount();
console.log('pushStatusOrder: all passed');
process.exit(0); // the push module's imports keep timers alive
