// CR-04-7: a page whose code failed to load (offline) loads again on its next mount (the error
// card's Try again, or opening the page again once back online) instead of failing until a reload.
// React's own immediate re-render of the failing mount keeps the failure (no import loop).
// Renders lazyViews' page() with react-dom in the harness DOM.
import { doc, installOnline } from '../../lib/__tests__/harness/dom';

// The device is offline (navigator.onLine false), so the automatic repair-and-reload stays off.
const net = installOnline();
net.online = false;

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { page } = await import('../views/lazyViews');

let attempts = 0;
let online = false;
let rendered = 0;
function Loaded() {
  rendered++;
  return null;
}
const TestPage = page('lessons', async () => {
  attempts++;
  if (!online) throw new TypeError('Failed to fetch dynamically imported module: /assets/Lessons-x1.js');
  return Loaded;
});

let caught: unknown = null;
class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    caught = error;
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const until = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert(check(), label);
};
const mount = () => {
  const root = createRoot((doc.createElement as () => Element)());
  root.render(
    React.createElement(Boundary, null, React.createElement(React.Suspense, { fallback: null }, React.createElement(TestPage)))
  );
  return root;
};

const originalError = console.error;
console.error = () => undefined; // React reports the caught load error; expected here.
try {
  // Offline: the page's code fails and the error card shows.
  const first = mount();
  await until(() => caught !== null, 'offline: the failed load reaches the error card');
  assert(rendered === 0, 'offline: the page did not render');
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert(attempts === 1, `offline: one import, React's re-render of the failing mount does not loop (attempts ${attempts})`);
  first.unmount();
  await new Promise((resolve) => setTimeout(resolve, 1600)); // the user presses Try again later

  // Back online: the next mount imports again and renders the page.
  online = true;
  net.online = true;
  caught = null;
  const second = mount();
  await until(() => rendered > 0 || caught !== null, 'second mount settled');
  assert(caught === null, `back online: the next mount loads the page instead of the kept failure (${String(caught)})`);
  assert(rendered > 0 && attempts === 2, `back online: imported again and rendered (attempts ${attempts})`);
  second.unmount();
} finally {
  console.error = originalError;
}

console.log('lazyPageRetry: all passed');
