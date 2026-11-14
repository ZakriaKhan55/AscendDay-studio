// CR-03-4: MasonryGrid (ui/MasonryGrid.tsx) keeps every card under one parent, so a column-count
// change (window resize, sidebar fold, phone rotation) moves cards without remounting them: a
// card's own state (an expanded plan card) survives. Placement and stacking stay as before: each
// card goes to the shortest column in list order, and a card that grows pushes down only its own
// column. Rendered with react-dom in the dom harness, with fake widths, heights and ResizeObserver.
import { container, find, type El } from './domTree';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// Layout stand-ins: the grid's width, each card's height (by key; React prefixes keys with ".$"),
// 16px rem, ResizeObserver.
let gridWidth = 1000;
const heights: Record<string, number> = { a: 100, b: 300, c: 100, d: 100 };
const g = globalThis as unknown as Record<string, unknown>;
g.getComputedStyle = () => ({ fontSize: '16px' });
const observers: { cb: () => void; targets: El[] }[] = [];
g.ResizeObserver = class {
  private entry: { cb: () => void; targets: El[] };
  constructor(cb: () => void) {
    this.entry = { cb, targets: [] };
    observers.push(this.entry);
  }
  observe(target: El) {
    this.entry.targets.push(target);
  }
  disconnect() {
    observers.splice(observers.indexOf(this.entry), 1);
  }
};
const resized = (target: El) => observers.filter((o) => o.targets.includes(target)).forEach((o) => o.cb());
const baseCreate = (document as unknown as { createElement: (t: string) => El }).createElement;
(document as unknown as { createElement: (t: string) => El }).createElement = (tag: string) => {
  const el = baseCreate(tag);
  el.style = {} as never;
  Object.defineProperty(el, 'clientWidth', { get: () => gridWidth });
  Object.defineProperty(el, 'offsetHeight', { get: () => heights[(el.getAttribute('data-masonry-key') ?? '').replace('.$', '')] ?? 0 });
  return el;
};

const React = await import('react');
const h = React.createElement;
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { MasonryGrid } = await import('../ui/MasonryGrid');

// A card with its own state, counting its mounts.
const mounts: Record<string, number> = {};
function Card({ id }: { id: string }) {
  const [expanded] = React.useState(() => `${id}-state`);
  React.useEffect(() => {
    mounts[id] = (mounts[id] ?? 0) + 1;
  }, [id]);
  return h('p', { 'data-state': expanded }, id);
}

const root = createRoot(container());
const render = () => flushSync(() => root.render(h(MasonryGrid, { minColumnRem: 20, children: ['a', 'b', 'c', 'd'].map((id) => h(Card, { key: id, id })) })));
render();
await wait();

const card = (key: string) => find((el) => el.getAttribute('data-masonry-key') === `.$${key}`, `card ${key}`);
const pos = (key: string) => {
  const style = card(key).style as unknown as Record<string, string>;
  return `${style.left} @ ${style.top}`;
};
const grid = card('a').parentNode as El;
const style = (el: El) => el.style as unknown as Record<string, string>;

// 1000px wide, 320px columns + 16px gap: 3 columns. a→0, b→1, c→2, d→0 (shortest after a).
eq(pos('a'), 'calc(0 * (100% + 1rem) / 3) @ 0px', 'a: first column, top');
eq(pos('b'), 'calc(1 * (100% + 1rem) / 3) @ 0px', 'b: second column, top');
eq(pos('c'), 'calc(2 * (100% + 1rem) / 3) @ 0px', 'c: third column, top');
eq(pos('d'), 'calc(0 * (100% + 1rem) / 3) @ 116px', 'd: under a (shortest column), after the 16px gap');
eq(style(grid).height, '300px', 'the grid is as tall as its tallest column');
assert(['a', 'b', 'c', 'd'].every((k) => card(k).parentNode === grid), 'all cards share one parent');
const elementsBefore = ['a', 'b', 'c', 'd'].map(card);

// A card that grows (Show more) pushes down only its own column; nobody changes column.
heights.a = 250;
resized(card('a'));
eq(pos('d'), 'calc(0 * (100% + 1rem) / 3) @ 266px', 'a grew: d moves down in its own column');
eq(pos('b'), 'calc(1 * (100% + 1rem) / 3) @ 0px', 'a grew: b stays');
eq(pos('c'), 'calc(2 * (100% + 1rem) / 3) @ 0px', 'a grew: c stays');
heights.a = 100;
resized(card('a'));

// Narrower (sidebar unfolds, phone rotates): 2 columns. Cards move but are not remounted.
gridWidth = 700;
flushSync(() => resized(grid));
await wait();
eq(pos('a'), 'calc(0 * (100% + 1rem) / 2) @ 0px', '2 columns: a first column');
eq(pos('b'), 'calc(1 * (100% + 1rem) / 2) @ 0px', '2 columns: b second column');
eq(pos('c'), 'calc(0 * (100% + 1rem) / 2) @ 116px', '2 columns: c under a');
eq(pos('d'), 'calc(0 * (100% + 1rem) / 2) @ 232px', '2 columns: d under c');
assert(['a', 'b', 'c', 'd'].every((k, i) => card(k) === elementsBefore[i]), 'the same card elements, only moved');
eq(JSON.stringify(mounts), JSON.stringify({ a: 1, b: 1, c: 1, d: 1 }), 'no card was remounted (its state survives)');
assert(String(style(card('a')).width).includes('/ 2'), `cards take the 2-column width (${style(card('a')).width})`);

flushSync(() => root.unmount());
console.log('masonryGrid: all passed');
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
