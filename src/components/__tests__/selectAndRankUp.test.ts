// Rendered with react-dom in the dom harness (CodeRabbit, 2026-11-14):
//   CR-03-27 an uncontrolled Select whose options arrive after it mounts takes the first enabled
//            option, like a native select (it stayed on "" before);
//   CR-03-13 the rank-up overlay scrolls on a screen too short for it (a phone on its side), so
//            Continue stays reachable: the overlay scrolls vertically, its content centres with
//            auto margins (top reachable when it overflows), and the backdrop stays fixed.
//   1.8.0    leaving Beginner adds the line "Misses now cost points (half until Achiever).", read
//            with the description; other climbs have no such line.
import { container, find, findAll, propsOf, textOf, type El } from './domTree';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const classes = (el: El) => String(el.getAttribute('class') ?? el.className ?? '').split(/\s+/);

const React = await import('react');
const h = React.createElement;
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { Select } = await import('../ui/primitives/Select');
const { RankUpCelebration } = await import('../ui/RankUpCelebration');

// --- CR-03-27 -----------------------------------------------------------------------------
{
  const root = createRoot(container());
  const select = (skills: string[]) =>
    h(Select, { 'aria-label': 'Skill', name: 'skill' }, ...skills.map((s) => h('option', { key: s, value: s }, s)));
  flushSync(() => root.render(select([])));
  await wait();
  const native = () => find((el) => el.tagName === 'SELECT', 'the hidden native select');
  assert(propsOf(native()).value === '', 'no options yet: no value');
  flushSync(() => root.render(select(['guitar', 'chess'])));
  await wait();
  assert(propsOf(native()).value === 'guitar', `options that arrive later: the first one is chosen (got ${JSON.stringify(propsOf(native()).value)})`);
  flushSync(() => root.render(select(['chess'])));
  await wait();
  assert(propsOf(native()).value === 'chess', `the chosen option removed: the first one left (got ${JSON.stringify(propsOf(native()).value)})`);
  flushSync(() => root.unmount());
}

// --- CR-03-13 -----------------------------------------------------------------------------
{
  const root = createRoot(container());
  flushSync(() => root.render(h(RankUpCelebration, { from: 0, to: 1, seasonPoints: 120, onClose: () => undefined })));
  await wait();
  const overlay = find((el) => el.getAttribute('role') === 'dialog', 'the rank-up overlay');
  const c = classes(overlay);
  assert(c.includes('overflow-y-auto') && c.includes('overflow-x-hidden') && !c.includes('overflow-hidden'), `the overlay scrolls vertically (${c.join(' ')})`);
  assert(!c.includes('items-center'), 'the overlay does not centre with align-items (that cuts off the top when it overflows)');
  const content = find((el) => el.parentNode === overlay && classes(el).includes('max-w-sm'), 'the overlay content');
  assert(classes(content).includes('my-auto'), 'the content centres with auto margins');
  const backdrop = find((el) => classes(el).includes('rankup-backdrop'), 'the backdrop');
  assert(classes(backdrop).includes('fixed'), 'the backdrop stays fixed while the content scrolls');
  const note = find((el) => textOf(el) === 'Misses now cost points (half until Achiever).' && el.tagName === 'P', 'the Beginner -> Starter penalty line');
  const describedBy = String(overlay.getAttribute('aria-describedby') ?? '').split(' ');
  assert(describedBy.length === 2 && describedBy[1] === note.getAttribute('id'), 'the penalty line is part of the overlay description');
  flushSync(() => root.unmount());
}

// --- 1.8.0: no penalty line for a climb that does not leave Beginner -------------------------
{
  const root = createRoot(container());
  flushSync(() => root.render(h(RankUpCelebration, { from: 1, to: 2, seasonPoints: 520, onClose: () => undefined })));
  await wait();
  const overlay = find((el) => el.getAttribute('role') === 'dialog', 'the rank-up overlay');
  assert(findAll((el) => el.tagName === 'P' && textOf(el).startsWith('Misses now cost points')).length === 0, 'Starter -> Learner: no penalty line');
  assert(String(overlay.getAttribute('aria-describedby') ?? '').split(' ').length === 1, 'Starter -> Learner: description only');
  flushSync(() => root.unmount());
}

console.log('selectAndRankUp: all passed');
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
