// Small component fixes from the CodeRabbit review (2026-11-14), rendered with react-dom in the dom
// harness:
//   CR-03-26 ProgressBar announces decimal values as they are (2.5 of 5, not 3);
//   CR-03-9  the show/hide password button is reachable with Tab (no tabindex -1), after the field;
//   CR-03-23 a raw control with a form problem points at its message (aria-describedby), ahead of
//            its own hint, and gets the hint back when the problem clears;
//   CR-03-17 a toast stays paused while it has keyboard focus, even when the pointer leaves it;
//   CR-03-14 Rename: Cancel, then reopening the same item starts from the saved name again;
//   CR-03-11 Update progress: rounding never lifts the saved total past a 3-decimal goal;
//   CR-03-12 Update progress: the amount, − / + and mode buttons are locked while saving.
import { container, find, findAll, propsOf, textOf, type El } from './domTree';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const React = await import('react');
const h = React.createElement;
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { ProgressBar, Form, FieldMessage, useFormController } = await import('../ui/primitives');
const { PasswordInput } = await import('../ui/PasswordInput');
const { ToastProvider } = await import('../ui/Toast');
const { RenameDialog } = await import('../ui/RenameDialog');
const { ProgressUpdateDialog } = await import('../ui/ProgressUpdateDialog');

const byId = (id: string) => find((el) => el.getAttribute('id') === id, `#${id}`);
function mount(node: React.ReactElement) {
  const root = createRoot(container());
  flushSync(() => root.render(node));
  return root;
}

// --- CR-03-26 ProgressBar -----------------------------------------------------------------
{
  const root = mount(h(ProgressBar, { value: 2.5, max: 5, label: 'Distance' }));
  const bar = find((el) => el.getAttribute('role') === 'progressbar', 'the progress bar');
  eq(bar.getAttribute('aria-valuenow'), '2.5', 'a decimal value is announced as it is');
  flushSync(() => root.render(h(ProgressBar, { value: 7, max: 5, label: 'Distance' })));
  eq(bar.getAttribute('aria-valuenow'), '5', 'a value over the goal is still capped at the goal');
  flushSync(() => root.unmount());
}

// --- CR-03-9 PasswordInput ----------------------------------------------------------------
{
  const root = mount(h(PasswordInput, { id: 'pw', label: 'Password', value: '', onChange: () => undefined }));
  const toggle = find((el) => el.tagName === 'BUTTON' && (el.getAttribute('aria-label') ?? '').includes('password'), 'the show/hide button');
  assert(!toggle.hasAttribute('tabindex'), `the show/hide button is in the Tab order (tabindex ${toggle.getAttribute('tabindex')})`);
  const input = byId('pw');
  const row = input.parentNode as El;
  assert(row.childNodes.indexOf(toggle) > row.childNodes.indexOf(input), 'the button comes after the field');
  assert(typeof propsOf(toggle).onMouseDown === 'function', 'a mouse click still keeps focus in the field');
  flushSync(() => root.unmount());
}

// --- CR-03-23 Form + raw control ----------------------------------------------------------
{
  let controller: ReturnType<typeof useFormController> | null = null;
  function RawForm() {
    controller = useFormController();
    return h(
      Form,
      { onSubmit: () => undefined, controller },
      h('input', { id: 'raw', 'aria-describedby': 'raw-hint', onChange: () => undefined, value: '' }),
      h(FieldMessage, { htmlFor: 'raw' }),
      h('p', { id: 'raw-hint' }, 'A hint')
    );
  }
  const root = mount(h(RawForm));
  await wait();
  const raw = byId('raw');
  flushSync(() => controller!.showError('Fill in this field.', 'raw'));
  await wait();
  eq(raw.getAttribute('aria-invalid'), 'true', 'the raw control is marked invalid');
  eq(byId('raw-error') && textOf(byId('raw-error')).includes('Fill in this field.'), true, 'its message is on screen');
  eq(raw.getAttribute('aria-describedby'), 'raw-error raw-hint', 'the control points at its message, then its hint');
  flushSync(() => controller!.clear());
  await wait();
  eq(raw.getAttribute('aria-invalid'), null, 'cleared: not invalid');
  eq(raw.getAttribute('aria-describedby'), 'raw-hint', 'cleared: the hint description is back as it was');
  flushSync(() => root.unmount());
}

// --- CR-03-17 Toast -----------------------------------------------------------------------
{
  const root = mount(h(ToastProvider, null, null));
  await wait();
  flushSync(() =>
    (window as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent({ type: 'app-toast-success', detail: { title: 'Saved' } })
  );
  await wait();
  const card = find((el) => typeof propsOf(el).onMouseEnter === 'function' && textOf(el).includes('Saved'), 'the toast');
  const bar = () => find((el) => el.getAttribute('aria-hidden') === 'true' && String(el.className ?? el.getAttribute('class')).includes('toast-timer'), 'the timer bar');
  const state = () => (bar().style as Record<string, string>).animationPlayState;
  const fire = (name: string, event: unknown = {}) => flushSync(() => (propsOf(card)[name] as (e: unknown) => void)(event));
  eq(state(), 'running', 'a new toast runs');
  const dismiss = find((el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Dismiss toast', 'the dismiss button');
  fire('onFocus');
  fire('onMouseEnter');
  fire('onMouseLeave');
  eq(state(), 'paused', 'focused, the pointer leaving does not resume it');
  fire('onMouseEnter');
  fire('onBlur', { currentTarget: card, relatedTarget: null });
  eq(state(), 'paused', 'hovered, focus leaving does not resume it');
  fire('onFocus');
  fire('onBlur', { currentTarget: card, relatedTarget: dismiss });
  fire('onMouseLeave');
  eq(state(), 'paused', 'focus moving inside the toast keeps it paused');
  fire('onBlur', { currentTarget: card, relatedTarget: null });
  eq(state(), 'running', 'neither hovered nor focused: it runs again');
  flushSync(() => root.unmount());
}

// --- CR-03-14 RenameDialog ----------------------------------------------------------------
{
  const props = (open: boolean) => ({
    open,
    onClose: () => undefined,
    title: 'Rename habit',
    label: 'Habit name',
    initialName: 'Read 10 pages',
    inputId: 'rename-input',
    maxLength: 60,
    validate: () => null,
    onSave: () => undefined,
  });
  const root = mount(h(RenameDialog, props(true)));
  await wait();
  const value = () => propsOf(byId('rename-input')).value;
  eq(value(), 'Read 10 pages', 'opens with the saved name');
  flushSync(() => (propsOf(byId('rename-input')).onChange as (e: unknown) => void)({ target: { value: 'Read 20 pages' } }));
  eq(value(), 'Read 20 pages', 'typing changes the draft');
  flushSync(() => root.render(h(RenameDialog, props(false)))); // Cancel (Discard): same item, still mounted
  await wait(250);
  flushSync(() => root.render(h(RenameDialog, props(true))));
  await wait();
  eq(value(), 'Read 10 pages', 'reopening the same item starts from the saved name, not the discarded draft');
  flushSync(() => root.unmount());
  await wait(250);
}

// --- CR-03-11 / CR-03-12 ProgressUpdateDialog ---------------------------------------------
{
  const saved: number[] = [];
  let finish: () => void = () => undefined;
  const root = mount(
    h(ProgressUpdateDialog, {
      open: true,
      onClose: () => undefined,
      title: 'Update progress',
      current: 0,
      target: 0.125, // a 3-decimal goal: its start amount rounds to 0.13
      format: (n: number) => `${n} km`,
      addLabel: 'Amount to add',
      setLabel: 'New total',
      decimal: true,
      onSave: (next: number) => {
        saved.push(next);
        return new Promise<void>((resolve) => (finish = resolve));
      },
    })
  );
  await wait();
  const form = find((el) => el.tagName === 'FORM' && el.getAttribute('id') === 'progress-update-form', 'the form');
  flushSync(() => (propsOf(form).onSubmit as (e: unknown) => void)({ preventDefault: () => undefined, currentTarget: { elements: [] } }));
  await wait();
  eq(saved.length, 1, 'Save sends one total');
  assert(saved[0] <= 0.125, `the saved total stays within the goal (got ${saved[0]})`);
  eq(saved[0], 0.125, 'the full goal is saved');

  // While the save is out, nothing in the form can change the amount.
  eq(propsOf(byId('progress-update-amount')).disabled, true, 'the amount field is locked while saving');
  for (const name of ['Decrease', 'Increase']) {
    eq(propsOf(find((el) => el.getAttribute('aria-label') === name, name)).disabled, true, `${name} is locked while saving`);
  }
  const modes = findAll((el) => el.hasAttribute('data-pill-id'));
  eq(modes.length, 2, 'both mode buttons are on screen');
  assert(modes.every((el) => propsOf(el).disabled === true), 'Add / Set total are locked while saving');
  flushSync(() => finish());
  await wait();
  flushSync(() => root.unmount());
}

console.log('uiPrimitivesA11y: all passed');
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
