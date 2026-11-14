// CR-01-14: in the Go to search (nav/CommandPalette.tsx), Enter and the arrows that confirm or pick
// IME text (Chinese, Japanese, … isComposing, or Safari's keyCode 229) never open a page; the same
// keys outside composition still do. Renders the palette with react-dom in the dom harness.
import { find, propsOf } from './domTree';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { CommandPalette } = await import('../nav/CommandPalette');

const went: string[] = [];
let closed = 0;
const root = createRoot((document as unknown as { createElement: (t: string) => Element }).createElement('div'));
flushSync(() =>
  root.render(
    React.createElement(CommandPalette, {
      open: true,
      onOpenChange: (open: boolean) => void (open ? undefined : closed++),
      currentView: 'settings',
      onViewChange: (view: string) => void went.push(view),
    })
  )
);
await new Promise((resolve) => setTimeout(resolve, 20));

const input = () => find((el) => el.getAttribute('role') === 'combobox', 'the search field');
const activeId = () => input().getAttribute('aria-activedescendant');
const press = (key: string, native: { isComposing: boolean; keyCode: number }) => {
  let prevented = false;
  flushSync(() =>
    (propsOf(input()).onKeyDown as (e: unknown) => void)({ key, keyCode: native.keyCode, nativeEvent: native, preventDefault: () => (prevented = true) })
  );
  return prevented;
};

const first = activeId();
assert(Boolean(first), 'an option is active');

// Composing: arrows and Enter go to the IME.
assert(!press('ArrowDown', { isComposing: true, keyCode: 40 }), 'ArrowDown while composing is left to the IME');
assert(activeId() === first, `ArrowDown while composing does not move the active page (${activeId()})`);
assert(!press('Enter', { isComposing: true, keyCode: 13 }), 'Enter while composing is left to the IME');
assert(!press('Enter', { isComposing: false, keyCode: 229 }), 'Safari confirming Enter (keyCode 229) is left to the IME');
assert(went.length === 0 && closed === 0, `no page opened and the palette stayed open (went ${went.join(',')}, closed ${closed})`);

// Not composing: the keys work as before.
assert(press('ArrowDown', { isComposing: false, keyCode: 40 }), 'ArrowDown moves the active page');
assert(activeId() !== first, 'ArrowDown moved the active page');
assert(press('Enter', { isComposing: false, keyCode: 13 }), 'Enter picks the page');
assert(went.length === 1 && closed === 1, `Enter opened one page and closed the palette (went ${went.join(',')}, closed ${closed})`);

root.unmount();
console.log('commandPaletteIme: all passed');
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
