// public/sw.js run in a stand-in worker (fake caches, fetch and fetch events), for its page and
// build-file caching:
//   SW1 (CR-01-9)  an app address that answers something other than HTML (/manifest.json, /robots.txt
//                  typed in the address bar) never replaces the kept app shell; an HTML answer does.
//   SW2 (CR-01-10) every cache write made after the answer is tied to its fetch event (waitUntil),
//                  so the worker is not stopped before the copy is saved.
//   SW3 (CR-01-11) a build file whose copy cannot be saved (storage full) is still answered.
import serviceWorker from '../../../public/sw.js?raw';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const ORIGIN = 'https://ascendday.com';
type Stored = Map<string, Response>;
const stores = new Map<string, Stored>();
let putFails = false;
const keyOf = (key: unknown) => (typeof key === 'string' ? key : (key as { url: string }).url);

function cacheFor(name: string) {
  if (!stores.has(name)) stores.set(name, new Map());
  const store = stores.get(name)!;
  return {
    match: async (key: unknown) => store.get(keyOf(key))?.clone(),
    put: async (key: unknown, response: Response) => {
      await Promise.resolve();
      if (putFails) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      store.set(keyOf(key), response);
    },
    keys: async () => [...store.keys()],
    delete: async (key: unknown) => store.delete(keyOf(key)),
  };
}

const caches = {
  open: async (name: string) => cacheFor(name),
  has: async (name: string) => stores.has(name),
  keys: async () => [...stores.keys()],
  delete: async (name: string) => stores.delete(name),
  match: async (key: unknown, options?: { cacheName?: string }) => {
    const names = options?.cacheName ? [options.cacheName] : [...stores.keys()];
    for (const name of names) {
      const hit = stores.get(name)?.get(keyOf(key));
      if (hit) return hit.clone();
    }
    return undefined;
  },
};

let answer: () => Response = () => new Response('');
const fetchStub = async () => answer();

const listeners = new Map<string, (event: unknown) => void>();
const self = {
  location: { origin: ORIGIN },
  addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
  skipWaiting() {},
  clients: { claim: async () => undefined, matchAll: async () => [] },
  registration: {},
};
new Function('self', 'caches', 'fetch', serviceWorker)(self, caches, fetchStub);
const onFetch = listeners.get('fetch')!;
assert(Boolean(onFetch), 'sw.js has a fetch listener');

/** Dispatches one fetch event; resolves with its answer once every waitUntil promise settled. */
async function dispatch(path: string, mode: 'navigate' | 'no-cors') {
  let responded: Promise<Response> | null = null;
  const lifetime: Promise<unknown>[] = [];
  onFetch({
    request: { method: 'GET', url: `${ORIGIN}${path}`, mode },
    respondWith: (p: Promise<Response>) => (responded = p),
    waitUntil: (p: Promise<unknown>) => lifetime.push(p),
  });
  assert(responded !== null, `${path} answered by the worker`);
  const response = await responded!;
  // waitUntil may be called after the answer's own awaits: drain until no new promise appears.
  for (let seen = -1; seen !== lifetime.length; ) {
    seen = lifetime.length;
    await Promise.allSettled(lifetime);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { response, waited: lifetime.length };
}

const shell = () => stores.get('ascend-shell-v1')?.get('/__ascend/app-shell');
const html = (body: string) => () => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

// SW1: the shell is the app's HTML; a non-HTML answer to an app-side navigation is not kept.
answer = html('<div id="root"></div>');
const first = await dispatch('/dashboard', 'navigate');
assert((await shell()?.clone().text()) === '<div id="root"></div>', 'SW1: an app page keeps its HTML as the shell');
for (const [path, type] of [
  ['/manifest.json', 'application/json'],
  ['/robots.txt', 'text/plain'],
  ['/sitemap.xml', 'application/xml'],
  ['/android-chrome-192x192.png', 'image/png'],
]) {
  answer = () => new Response('not the app', { headers: { 'content-type': type } });
  const { response } = await dispatch(path, 'navigate');
  assert((await response.text()) === 'not the app', `SW1: ${path} is still shown`);
  assert((await shell()?.clone().text()) === '<div id="root"></div>', `SW1: ${path} (${type}) does not replace the shell`);
}
answer = html('<div id="root">v2</div>');
await dispatch('/habits', 'navigate');
assert((await shell()?.clone().text()) === '<div id="root">v2</div>', 'SW1: a newer app page HTML replaces the shell');
console.log('✓ SW1 only HTML is kept as the offline app shell');

// SW2: every background cache write is handed to waitUntil.
assert(first.waited > 0, 'SW2: app page shell write waited on');
answer = html('<main>landing</main>');
assert((await dispatch('/features', 'navigate')).waited > 0, 'SW2: public page write waited on');
assert(stores.get('ascend-marketing-v1')?.has('/features') === true, 'SW2: public page kept');
answer = () => new Response('{}', { headers: { 'content-type': 'application/json' } });
assert((await dispatch('/manifest.json', 'no-cors')).waited > 0, 'SW2: static file write waited on');
answer = () => new Response('console.log(1)', { headers: { 'content-type': 'text/javascript' } });
assert((await dispatch('/assets/index-a1.js', 'no-cors')).waited > 0, 'SW2: build file write waited on');
assert(stores.get('ascend-assets-v2')?.has(`${ORIGIN}/assets/index-a1.js`) === true, 'SW2: build file kept');
console.log('✓ SW2 cache writes are tied to their fetch event');

// SW3: storage full: the build file is answered anyway, just not kept.
putFails = true;
answer = () => new Response('console.log(2)', { headers: { 'content-type': 'text/javascript' } });
let failed: unknown = null;
const asset = await dispatch('/assets/page-b2.js', 'no-cors').catch((error: unknown) => (failed = error));
assert(failed === null, `SW3: a failed cache write does not fail the request (${String(failed)})`);
assert((await (asset as { response: Response }).response.text()) === 'console.log(2)', 'SW3: the fetched file is answered');
assert(stores.get('ascend-assets-v2')?.has(`${ORIGIN}/assets/page-b2.js`) !== true, 'SW3: not kept');
putFails = false;
console.log('✓ SW3 a build file is answered when its copy cannot be saved');

console.log('serviceWorkerCache: all passed');
