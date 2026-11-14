// CodeRabbit phase 6 hook fixes (2026-11-14), rendered in Node with the dom harness:
//   CR-04-10 useAsyncAction / useAsyncActionKey stay loading until the last overlapping call ends
//   CR-06-17 useCompletionPop: an arm lasts one completion; an uncheck and check from another device
//            never pops
//   CR-06-18 useScrollFade: tabs added after mount are measured (the end fade appears)
//   CR-06-16 scrollRise: an element moved (removed and put back) while waiting below the screen is
//            watched again instead of staying hidden
import { doc, win } from './harness/dom';

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { useAsyncAction, useAsyncActionKey } = await import('../actions/useAsyncAction');
const { useCompletionPop } = await import('../ui/useCompletionPop');
const { useScrollFade } = await import('../ui/useScrollFade');

function assert(condition: unknown, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const container = () => (doc.createElement as () => Element)();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
async function until(check: () => boolean, msg: string, ms = 2000) {
  const end = Date.now() + ms; // eslint-disable-line no-restricted-syntax -- test timeout, not app time
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${msg}`); // eslint-disable-line no-restricted-syntax -- test timeout
    await wait(5);
  }
}

// CR-04-10
{
  let single!: ReturnType<typeof useAsyncAction<[Promise<void>], void>>;
  let keyed!: ReturnType<typeof useAsyncActionKey>;
  const run = (p: Promise<void>) => p;
  function Probe() {
    single = useAsyncAction(run);
    keyed = useAsyncActionKey();
    return null;
  }
  const root = createRoot(container());
  flushSync(() => root.render(React.createElement(Probe)));

  const a = deferred();
  const b = deferred();
  const first = single.execute(a.promise);
  const second = single.execute(b.promise);
  await until(() => single.isLoading, 'execute: loading');
  a.resolve();
  await first;
  await wait(30);
  eq(single.isLoading, true, 'execute: still loading while the second call runs');
  b.resolve();
  await second;
  await until(() => !single.isLoading, 'execute: done after the last call');

  const c = deferred();
  const d = deferred();
  const third = keyed.executeWithKey('row', () => c.promise);
  const fourth = keyed.executeWithKey('row', () => d.promise);
  await until(() => keyed.isKeyLoading('row'), 'key: loading');
  c.resolve();
  await third;
  await wait(30);
  eq(keyed.isKeyLoading('row'), true, 'key: still loading while the second call on it runs');
  d.resolve();
  await fourth;
  await until(() => !keyed.isKeyLoading('row'), 'key: done after the last call');
  root.unmount();
  console.log('CR-04-10 overlapping calls: passed');
}

// CR-06-17
{
  let pop!: ReturnType<typeof useCompletionPop>;
  function Row({ done }: { done: boolean }) {
    pop = useCompletionPop(done);
    return null;
  }
  const root = createRoot(container());
  const show = (done: boolean) => flushSync(() => root.render(React.createElement(Row, { done })));
  show(false);
  flushSync(() => pop.arm());
  show(true);
  eq(pop.popClass, 'animate-pop', 'a local completion pops');
  show(false); // unchecked on another device
  show(true); // checked again there
  eq(pop.popClass, '', 'a completion from another device does not pop');
  show(false);
  flushSync(() => pop.arm());
  show(true);
  eq(pop.popClass, 'animate-pop', 'checking again here pops again');
  root.unmount();
  console.log('CR-06-17 completion pop: passed');
}

// CR-06-18
{
  const g = globalThis as unknown as Record<string, unknown>;
  const resizeObserved = new Set<unknown>();
  let childWatch: ((records: { addedNodes: unknown[]; removedNodes: unknown[] }[]) => void) | null = null;
  g.ResizeObserver = class {
    observe(t: unknown) {
      resizeObserved.add(t);
    }
    unobserve(t: unknown) {
      resizeObserved.delete(t);
    }
    disconnect() {
      resizeObserved.clear();
    }
  };
  g.MutationObserver = class {
    constructor(cb: typeof childWatch) {
      childWatch = cb;
    }
    observe() {}
    disconnect() {}
  };
  if (typeof g.Element === 'undefined') g.Element = class {};
  const ElementClass = g.Element as new () => object;
  const attrs = new Set<string>();
  const tab = () => new ElementClass();
  const strip = {
    scrollWidth: 300,
    clientWidth: 300,
    scrollLeft: 0,
    children: [tab(), tab()],
    toggleAttribute: (name: string, on: boolean) => void (on ? attrs.add(name) : attrs.delete(name)),
    removeAttribute: (name: string) => void attrs.delete(name),
    addEventListener() {},
    removeEventListener() {},
  };
  const ref = { current: strip as unknown as HTMLElement };
  function Strip() {
    useScrollFade(ref);
    return null;
  }
  const root = createRoot(container());
  flushSync(() => root.render(React.createElement(Strip)));
  await wait(10);
  eq(attrs.has('data-fade-end'), false, 'fits: no end fade');
  assert(childWatch, 'the strip watches its children');
  const added = tab();
  strip.children.push(added);
  strip.scrollWidth = 420; // the strip itself keeps its size
  childWatch!([{ addedNodes: [added], removedNodes: [] }]);
  eq(attrs.has('data-fade-end'), true, 'a tab added later shows the end fade');
  assert(resizeObserved.has(added), 'the new tab is measured from now on');
  root.unmount();
  console.log('CR-06-18 scroll fade: passed');
}

// CR-06-16 (last: it installs an HTMLElement global)
{
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.HTMLElement === 'undefined') g.HTMLElement = class {};
  const Base = g.HTMLElement as new () => object;
  class Card extends Base {
    attrs = new Map<string, string>();
    parentElement = null;
    hasAttribute(k: string) {
      return this.attrs.has(k);
    }
    getAttribute(k: string) {
      return this.attrs.get(k) ?? null;
    }
    setAttribute(k: string, v: string) {
      this.attrs.set(k, v);
    }
    removeAttribute(k: string) {
      this.attrs.delete(k);
    }
    matches() {
      return true;
    }
    querySelectorAll() {
      return [];
    }
    getBoundingClientRect() {
      return { top: 2000 };
    }
  }
  const watched = new Set<unknown>();
  g.IntersectionObserver = class {
    observe(t: unknown) {
      watched.add(t);
    }
    unobserve(t: unknown) {
      watched.delete(t);
    }
  };
  let bodyWatch: ((records: { addedNodes: unknown[]; removedNodes: unknown[] }[]) => void) | null = null;
  g.MutationObserver = class {
    constructor(cb: typeof bodyWatch) {
      bodyWatch = cb;
    }
    observe() {}
  };
  g.CSS = { supports: () => true };
  win.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  win.innerHeight = 800;
  const { installScrollRise } = await import('../ui/scrollRise');
  installScrollRise();
  assert(bodyWatch, 'scroll rise watches the page');
  const card = new Card();
  bodyWatch!([{ addedNodes: [card], removedNodes: [] }]);
  eq(card.getAttribute('data-rise'), 'wait', 'a card below the screen waits');
  assert(watched.has(card), 'the waiting card is watched');
  // React moves the card (a reorder): removed, then put back.
  bodyWatch!([{ addedNodes: [], removedNodes: [card] }]);
  bodyWatch!([{ addedNodes: [card], removedNodes: [] }]);
  eq(card.getAttribute('data-rise'), 'wait', 'the moved card waits again');
  assert(watched.has(card), 'the moved card is watched again, so it can rise');
  console.log('CR-06-16 scroll rise: passed');
}

console.log('crP6Hooks: all checks passed');
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
