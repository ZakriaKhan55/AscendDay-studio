// Where keyboard focus goes (CodeRabbit, 2026-11-14), rendered with react-dom in the dom harness:
//   CR-03-22 Dialog opening with new content (contentKey changed while closed) saves its opener
//            before it moves focus inside, so closing returns focus to the opener;
//   CR-03-5  Notifications: when Mark all read removes the focused button, Tab comes back into
//            the panel instead of leaving it;
//   CR-03-6  Notifications: the release-notes dialog returns focus to the bell when it closes.
import { activeElement, body, container, find, propsOf, textOf, type El } from './domTree';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { Dialog } = await import('../ui/primitives/Dialog');
const { NotificationCenter } = await import('../ui/NotificationCenter');
const { RELEASE_NOTE } = await import('@/lib/releaseNote');

const label = (el: El) => el.getAttribute('aria-label') ?? '';
const describe = (el: El | null) => (el === body ? 'the page body' : el ? `${el.tagName} "${label(el) || textOf(el).slice(0, 30)}"` : 'nothing');
const tab = (shiftKey = false) => {
  let prevented = false;
  (document as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent({
    type: 'keydown',
    key: 'Tab',
    shiftKey,
    preventDefault: () => (prevented = true),
    stopPropagation: () => undefined,
  });
  return prevented;
};

// --- CR-03-22: Dialog with a new contentKey on open ------------------------------------------
{
  const opener = (document as unknown as { createElement: (t: string) => El }).createElement('button');
  body.appendChild(opener as never);
  opener.focus();
  const root = createRoot(container());
  const dialog = (open: boolean, contentKey: string) =>
    React.createElement(Dialog, { open, onClose: () => undefined, title: 'Guide', contentKey }, React.createElement('p', null, contentKey));
  flushSync(() => root.render(dialog(false, 'steps')));
  // Opened at another section (HowItWorks at Points, LessonReader on another lesson).
  flushSync(() => root.render(dialog(true, 'points')));
  await wait();
  const panel = find((el) => el.getAttribute('role') === 'dialog', 'the dialog');
  assert(activeElement() === panel, `focus moves into the dialog (on ${describe(activeElement())})`);
  flushSync(() => root.render(dialog(false, 'points')));
  await wait();
  assert(activeElement() === opener, `closing returns focus to the opener (on ${describe(activeElement())})`);
  flushSync(() => root.unmount());
  await wait(300);
}

// --- Notifications ------------------------------------------------------------------------
const notifications = [
  { id: 'n1', type: 'partner_request', title: 'Partner request', message: 'Sara wants to partner', read: false, createdAt: '2026-11-14T10:00:00Z' },
  { id: 'n2', type: 'partner_request', title: 'Partner request', message: 'Ali wants to partner', read: false, createdAt: '2026-11-14T09:00:00Z' },
];
const state = {
  notifications,
  lastSeenRelease: RELEASE_NOTE?.id ?? 0,
  currentUser: { id: 'u1', username: 'me', createdAt: '2020-01-01T00:00:00Z' },
};
const root = createRoot(container());
const renderCenter = () => flushSync(() => root.render(React.createElement(NotificationCenter, { store })));
const store = {
  state,
  markNotificationRead: () => undefined,
  markNotificationsRead: () => undefined,
  markAllNotificationsRead: () => {
    state.notifications = state.notifications.map((n) => ({ ...n, read: true }));
    renderCenter();
  },
  clearReadNotifications: () => undefined,
  refreshNotifications: async () => undefined,
} as never;
renderCenter();
await wait();

const bell = () => find((el) => el.tagName === 'BUTTON' && el.getAttribute('aria-haspopup') === 'dialog', 'the bell');
const open = () => {
  flushSync(() => (propsOf(bell()).onClick as () => void)());
};
const notifPanel = () => find((el) => el.getAttribute('aria-labelledby') === 'notification-panel-title', 'the notifications panel');

// CR-03-5: keyboard focus on Mark all read, which then disappears.
open();
await wait();
const markAll = find((el) => el.tagName === 'BUTTON' && textOf(el).includes('Mark all read'), 'Mark all read');
markAll.focus();
flushSync(() => (propsOf(markAll).onClick as () => void)());
await wait();
assert(!notifPanel().contains(activeElement()), 'control: the removed button took focus out of the panel');
assert(tab() === true, 'Tab after the button went away is handled by the panel');
assert(notifPanel().contains(activeElement()), `Tab brings focus back into the panel (on ${describe(activeElement())})`);
markAll.focus(); // detached now: focus is outside the panel again
assert(tab(true) === true && notifPanel().contains(activeElement()), `Shift+Tab also comes back into the panel (on ${describe(activeElement())})`);

// CR-03-6: open the release note from the panel, then close it.
const noteButton = find((el) => el.tagName === 'BUTTON' && textOf(el).includes(RELEASE_NOTE?.title || 'What'), 'the release note row');
noteButton.focus();
flushSync(() => (propsOf(noteButton).onClick as () => void)());
await wait();
const whatsNew = find((el) => el.getAttribute('role') === 'dialog' && el.getAttribute('aria-modal') === 'true' && el !== (null as unknown), 'the release-notes dialog');
assert(whatsNew.contains(activeElement()) || activeElement() === whatsNew, `focus is in the release-notes dialog (on ${describe(activeElement())})`);
const close = find((el) => el.tagName === 'BUTTON' && label(el) === 'Close', 'the dialog close button');
flushSync(() => (propsOf(close).onClick as () => void)());
await wait(300);
assert(activeElement() === bell(), `closing the release notes returns focus to the bell (on ${describe(activeElement())})`);

flushSync(() => root.unmount());
console.log('focusReturn: all passed');
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
