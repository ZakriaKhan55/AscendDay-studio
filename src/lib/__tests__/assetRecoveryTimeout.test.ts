// CR-04-18: Repair app (and the automatic repair) reloads even when the stylesheet refetch before
// the reload hangs: the refetch is given up after a few seconds and aborted.
import { doc, win } from './harness/dom';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const g = globalThis as unknown as Record<string, unknown>;
const dropped: string[] = [];
g.caches = {
  keys: async () => ['ascend-assets-v2', 'ascend-push-v1'],
  delete: async (name: string) => dropped.push(name) > 0,
};
doc.querySelector = (selector: string) =>
  selector.includes('stylesheet') ? { href: 'https://ascendday.com/assets/index-a1.css' } : null;
let aborted = false;
let refetchOptions: RequestInit | undefined;
g.fetch = (_url: string, options?: RequestInit) => {
  refetchOptions = options;
  options?.signal?.addEventListener('abort', () => (aborted = true));
  return new Promise(() => undefined); // a stalled connection: never answers
};
let reloads = 0;
(win.location as unknown as Record<string, unknown>).reload = () => reloads++;

const { repairBuildFiles } = await import('../app/assetRecovery');
const started = performance.now();
assert(repairBuildFiles({ automatic: false }), 'Repair app runs');
for (let i = 0; i < 80 && reloads === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100));
const waited = performance.now() - started;
assert(reloads === 1, `the page reloads although the stylesheet refetch never answers (waited ${Math.round(waited)} ms)`);
assert(waited >= 4_500 && waited < 7_000, `after about 5 s (${Math.round(waited)} ms)`);
assert(aborted, 'the hung refetch is aborted');
assert(refetchOptions?.cache === 'reload', 'the refetch still bypasses the HTTP cache');
assert(dropped.includes('ascend-assets-v2') && !dropped.includes('ascend-push-v1'), 'build caches dropped, push cache kept');

console.log('assetRecoveryTimeout: all passed');
