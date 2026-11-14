// Progress update dialog (ui/ProgressUpdateDialog.tsx), CodeRabbit CR-03-10, 2026-11-14: the
// amount the Add field starts with is rounded like the field's max. Before, a plan at 21 of
// 21.1 km opened with 0.10000000000000142 in the field while its max was 0.1, so Save was refused
// ("Enter 0.1 or less."). Rendered in Node with the dom harness.
import { doc } from '../../lib/__tests__/harness/dom';

type FakeEl = Record<string, unknown> & { getAttribute: (k: string) => string | null };
const created: FakeEl[] = [];
const baseCreate = doc.createElement as (tag: string) => FakeEl;
doc.createElement = (tag: string) => {
  const el = baseCreate(tag);
  el.tagName = tag.toUpperCase();
  el.contains = () => false;
  el.focus = () => undefined;
  created.push(el);
  return el;
};
// Icons are SVG: same stand-in elements.
doc.createElementNS = (_ns: string, tag: string) => (doc.createElement as (tag: string) => FakeEl)(tag);
doc.createTextNode = (text: string) => ({ nodeType: 3, nodeValue: text, textContent: text });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { ProgressUpdateDialog } = await import('../ui/ProgressUpdateDialog');

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function addField(current: number, target: number, decimal: boolean) {
  created.length = 0;
  const root = createRoot((doc.createElement as (tag: string) => FakeEl)('div') as unknown as Element);
  flushSync(() =>
    root.render(
      React.createElement(ProgressUpdateDialog, {
        open: true,
        onClose: () => undefined,
        title: 'Update progress',
        current,
        target,
        format: (n: number) => `${n} km`,
        addLabel: 'Add',
        setLabel: 'Set total',
        decimal,
        onSave: () => undefined,
      })
    )
  );
  await wait(30);
  const input = created.find((el) => el.getAttribute('id') === 'progress-update-amount');
  assert(!!input, 'the Add field renders');
  const value = String(input!.value ?? input!.getAttribute('value'));
  const max = String(input!.max ?? input!.getAttribute('max'));
  flushSync(() => root.unmount());
  await wait(10);
  return { value, max };
}

// 21 of 21.1 km: 0.1 left.
const decimalCase = await addField(21, 21.1, true);
eq(decimalCase.max, '0.1', 'the field allows up to 0.1');
eq(decimalCase.value, '0.1', 'the field starts at 0.1, not float noise above its max');
assert(Number(decimalCase.value) <= Number(decimalCase.max), 'the starting amount is within the max, so Save is accepted');

// Whole numbers are unchanged: 40 of 100 pages starts at 1, more than a step left.
const wholeCase = await addField(40, 100, false);
eq(wholeCase.value, '1', 'whole numbers start at one step');
eq(wholeCase.max, '60', 'whole numbers: up to what is left');

console.log('progressUpdateStart: all assertions passed');
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
