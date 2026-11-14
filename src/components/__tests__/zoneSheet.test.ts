// Phone zone sheet (nav/ZoneSheet.tsx + nav/useZoneSheetOpen.ts), rendered in Node with the dom
// harness (CodeRabbit CR-01-15 / CR-01-16, 2026-11-14):
// - phone Back to the Dashboard while the sheet is open (open stays true, no zone) must not leave
//   the page scroll locked (<html> overflow: hidden) with nothing on screen;
// - the open flag resets when the zone on screen changes, so the sheet does not pop up again on
//   the next zone page; a page change inside the same zone keeps it open;
// - rows taller than the sheet scroll by touch (touch-pan-y), with the drag kept on the header.
import { doc, win } from '../../lib/__tests__/harness/dom';
import type { NavGroup } from '../nav/navConfig';
import type { View } from '@/lib/app/views';

// Text nodes and a record of every element React creates (the harness has neither).
type FakeEl = Record<string, unknown> & { getAttribute: (k: string) => string | null };
const created: FakeEl[] = [];
const baseCreate = doc.createElement as (tag: string) => FakeEl;
doc.createElement = (tag: string) => {
  const el = baseCreate(tag);
  el.tagName = tag.toUpperCase();
  el.contains = () => false;
  created.push(el);
  return el;
};
doc.createTextNode = (text: string) => ({ nodeType: 3, nodeValue: text, textContent: text });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
// flushSync: each step commits (layout and passive effects included) before the next line, so the
// test never depends on scheduler timing under load.
const { flushSync } = await import('react-dom');
const { ZoneSheet } = await import('../nav/ZoneSheet');
const { useZoneSheetOpen } = await import('../nav/useZoneSheetOpen');

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rootStyle = (doc.documentElement as { style: Record<string, string> }).style;
const container = () => (doc.createElement as (tag: string) => FakeEl)('div') as unknown as Element;

const NoIcon = () => null;
const TRACK = {
  id: 'track',
  label: 'Track',
  icon: NoIcon,
  items: [
    { id: 'habits', label: 'Habits', icon: NoIcon },
    { id: 'bad-habits', label: 'Bad habits', icon: NoIcon },
  ],
} as unknown as NavGroup;

function sheet(open: boolean, group: NavGroup | undefined, currentView: View) {
  return React.createElement(ZoneSheet, {
    open,
    group,
    currentView,
    statuses: {},
    partnerBadge: 0,
    onNavigate: () => undefined,
    onClose: () => undefined,
  });
}

// 1. Open on a zone page: the page behind is locked (proves the harness sees the lock).
rootStyle.overflow = '';
const root = createRoot(container());
flushSync(() => root.render(sheet(true, TRACK, 'habits')));
await wait(30);
eq(rootStyle.overflow, 'hidden', 'open sheet on a zone page locks the page scroll');

// 2. Phone Back to the Dashboard: AppShell's group turns undefined while open is still true.
flushSync(() => root.render(sheet(true, undefined, 'dashboard')));
await wait(30);
eq(rootStyle.overflow, '', 'no zone (Dashboard): the scroll lock is released');

// 3. Back to a zone page without a new tap would lock again only if still open; opening directly
//    with no zone never locks.
flushSync(() => root.unmount());
await wait(10);
rootStyle.overflow = '';
const root2 = createRoot(container());
flushSync(() => root2.render(sheet(true, undefined, 'dashboard')));
await wait(30);
eq(rootStyle.overflow, '', 'open with no zone never locks the page');
flushSync(() => root2.unmount());
await wait(10);

// 4. CR-01-16: rows taller than the sheet scroll by touch; the header keeps the drag.
created.length = 0;
const root3 = createRoot(container());
flushSync(() => root3.render(sheet(true, TRACK, 'habits')));
await wait(30);
const dialog = created.find((el) => el.getAttribute('role') === 'dialog');
assert(!!dialog, 'the sheet renders its dialog');
const cls = () => dialog!.getAttribute('class') ?? String(dialog!.className ?? '');
assert(/\btouch-none\b/.test(cls()) && !/\btouch-pan-y\b/.test(cls()), `rows that fit: whole sheet is touch-none (got "${cls()}")`);
dialog!.scrollHeight = 900;
dialog!.clientHeight = 600;
flushSync(() => (win as unknown as { dispatchEvent: (e: { type: string }) => void }).dispatchEvent({ type: 'resize' }));
await wait(30);
assert(/\btouch-pan-y\b/.test(cls()) && !/\btouch-none\b/.test(cls()), `rows taller than the sheet: touch-pan-y (got "${cls()}")`);
const header = created.find((el) => /\btouch-none\b/.test(el.getAttribute('class') ?? String(el.className ?? '')) && el !== dialog && el.getAttribute('aria-label') !== 'Close');
assert(!!header, 'the handle and title stay touch-none for the drag to close');
dialog!.scrollHeight = 500;
dialog!.clientHeight = 500;
flushSync(() => (win as unknown as { dispatchEvent: (e: { type: string }) => void }).dispatchEvent({ type: 'resize' }));
await wait(30);
assert(/\btouch-none\b/.test(cls()), 'rows fit again (rotated back): touch-none again');
flushSync(() => root3.unmount());
await wait(10);
eq(rootStyle.overflow, '', 'unmount releases the lock');

// 5. useZoneSheetOpen: closes when the zone changes, stays open inside the same zone.
let hook: readonly [boolean, (v: boolean | ((v: boolean) => boolean)) => void, () => void] | null = null;
function Probe({ zone }: { zone: string | null }) {
  hook = useZoneSheetOpen(zone);
  return null;
}
const root4 = createRoot(container());
flushSync(() => root4.render(React.createElement(Probe, { zone: 'track' })));
await wait(20);
eq(hook![0], false, 'starts closed');
flushSync(() => hook![1](true));
await wait(20);
eq(hook![0], true, 'opens');
flushSync(() => root4.render(React.createElement(Probe, { zone: 'track' })));
await wait(20);
eq(hook![0], true, 'another page of the same zone keeps it open');
flushSync(() => root4.render(React.createElement(Probe, { zone: null })));
await wait(20);
eq(hook![0], false, 'Back to the Dashboard (no zone) closes it');
flushSync(() => root4.render(React.createElement(Probe, { zone: 'track' })));
await wait(20);
eq(hook![0], false, 'arriving on a zone page afterwards does not pop the sheet up again');
flushSync(() => hook![1](true));
await wait(20);
flushSync(() => root4.render(React.createElement(Probe, { zone: 'mind' })));
await wait(20);
eq(hook![0], false, 'Back into another zone closes it');
flushSync(() => hook![1]((v) => !v));
await wait(20);
eq(hook![0], true, 'the zone button still toggles it');
flushSync(() => hook![2]());
await wait(20);
eq(hook![0], false, 'close() closes it');
flushSync(() => root4.unmount());

console.log('zoneSheet: all assertions passed');
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
