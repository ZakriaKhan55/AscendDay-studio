// CR-04-26: a Turnstile script request that never answers ends as a slow-internet failure after
// the script timeout (instead of leaving the form's button loading for good), and the next attempt
// loads the script again.
import { doc } from './harness/dom';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const scripts: { src?: string; removed: boolean; onload?: () => void }[] = [];
doc.createElement = () => {
  const script = { removed: false, remove: () => (script.removed = true) } as (typeof scripts)[number] & { remove(): void };
  return script;
};
(doc.head as Record<string, unknown>).appendChild = (node: (typeof scripts)[number]) => scripts.push(node);

const { loadTurnstile, CaptchaSolveError, captchaFailureMessage, CAPTCHA_SLOW_MESSAGE } = await import('../auth/captcha');

const settle = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise.then((value) => ({ value }), (error: unknown) => ({ error })), new Promise((resolve) => setTimeout(() => resolve('pending'), ms))]);

// The script request hangs (never loads, never errors).
const first = await settle(loadTurnstile(50), 1_000);
assert(first !== 'pending', 'a hung script request is given up');
const error = (first as { error?: unknown }).error;
assert(error instanceof CaptchaSolveError && error.failure === 'network', `ends as a network failure (${String(error)})`);
assert(captchaFailureMessage((error as InstanceType<typeof CaptchaSolveError>).failure) === CAPTCHA_SLOW_MESSAGE, 'shown as slow internet');
assert(scripts.length === 1 && scripts[0].removed, 'the hung script tag is removed');

// The next attempt loads the script again, and a script that loads in time is used.
const second = loadTurnstile(1_000);
await new Promise((resolve) => setTimeout(resolve, 0));
assert(scripts.length === 2 && !scripts[1].removed, 'the next attempt adds a fresh script');
const api = { render: () => 'w1', remove() {} };
(globalThis.window as unknown as Record<string, unknown>).turnstile = api;
scripts[1].onload?.();
const loaded = await settle(second, 1_000);
assert((loaded as { value?: unknown }).value === api, 'a script that loads in time is used');
await new Promise((resolve) => setTimeout(resolve, 1_100));
assert(!scripts[1].removed, 'a loaded script is not removed by the timeout afterwards');

console.log('captchaScriptTimeout: all passed');
