// A real element tree on top of the dom harness (lib/__tests__/harness/dom.ts), for tests that
// render components with react-dom in Node: parent/child links, contains, isConnected, focus and
// document.activeElement, the props React gave an element, and a small querySelectorAll.
// Importing this file installs it (after the harness). Not a test file itself (no .test.ts).
import { doc } from '../../lib/__tests__/harness/dom';

export type El = Record<string, unknown> & {
  tagName: string;
  parentNode: El | null;
  childNodes: El[];
  getAttribute: (k: string) => string | null;
  setAttribute: (k: string, v: string) => void;
  removeAttribute: (k: string) => void;
  hasAttribute: (k: string) => boolean;
  contains: (node: unknown) => boolean;
  focus: () => void;
  isConnected: boolean;
};

export const created: El[] = [];
const d = doc as Record<string, unknown> & { body: El; documentElement: El; activeElement: El | null };

function detach(child: El) {
  const parent = child.parentNode;
  if (!parent) return;
  // As in a browser: focus inside a node that leaves the document falls back to the body.
  if (d.activeElement && child.contains?.(d.activeElement)) d.activeElement = d.body;
  const i = parent.childNodes.indexOf(child);
  if (i >= 0) parent.childNodes.splice(i, 1);
  child.parentNode = null;
}

function descendants(el: El): El[] {
  return el.childNodes.flatMap((child) => (child.nodeType === 1 ? [child, ...descendants(child)] : []));
}

function track(el: El, tag: string): El {
  const attrs = new Map<string, string>();
  Object.assign(el, {
    tagName: tag.toUpperCase(),
    parentNode: null,
    childNodes: [],
    disabled: false,
    setAttribute: (k: string, v: string) => void attrs.set(k, String(v)),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    removeAttribute: (k: string) => void attrs.delete(k),
    hasAttribute: (k: string) => attrs.has(k),
    appendChild: (child: El) => {
      detach(child);
      el.childNodes.push(child);
      child.parentNode = el;
      return child;
    },
    insertBefore: (child: El, ref: El | null) => {
      detach(child);
      const i = ref ? el.childNodes.indexOf(ref) : -1;
      if (i < 0) el.childNodes.push(child);
      else el.childNodes.splice(i, 0, child);
      child.parentNode = el;
      return child;
    },
    removeChild: (child: El) => {
      detach(child);
      return child;
    },
    contains: (node: unknown) => {
      for (let n = node as El | null; n; n = n.parentNode) if (n === el) return true;
      return false;
    },
    focus: () => {
      d.activeElement = el;
    },
    blur: () => {
      if (d.activeElement === el) d.activeElement = d.body;
    },
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    scrollIntoView: () => undefined,
    setSelectionRange: () => undefined,
    matches: (selector: string) => matches(el, selector),
    closest: (selector: string) => {
      for (let n: El | null = el; n && n.nodeType === 1; n = n.parentNode) if (matches(n, selector)) return n;
      return null;
    },
    // Enough for the app's focus selectors: enabled buttons, links, inputs, and [tabindex] >= 0.
    querySelectorAll: (selector: string) => descendants(el).filter((node) => matches(node, selector)),
    querySelector: (selector: string) => descendants(el).find((node) => matches(node, selector)) ?? null,
  });
  Object.defineProperty(el, 'isConnected', {
    configurable: true,
    get: () => {
      for (let n: El | null = el; n; n = n.parentNode) if (n === d.body || n === d.documentElement) return true;
      return false;
    },
  });
  return el;
}

/** Focus selectors (button, a[href], input, [tabindex]) and `[attr]` / `[attr="value"]`. */
export function matches(node: El, selector: string): boolean {
  return selector.split(',').some((part) => {
    const s = part.trim();
    const attr = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (attr) return node.hasAttribute(attr[1]) && (attr[2] === undefined || node.getAttribute(attr[1]) === attr[2]);
    if (node.disabled) return false;
    const tag = s.match(/^([a-z]+)/)?.[1];
    if (tag && node.tagName === tag.toUpperCase()) return tag !== 'a' || node.hasAttribute('href');
    if (s.startsWith('[tabindex')) return node.hasAttribute('tabindex') && node.getAttribute('tabindex') !== '-1';
    return false;
  });
}

// `x instanceof HTMLInputElement` and friends, judged by tag name.
const g = globalThis as unknown as Record<string, unknown>;
for (const [name, tag] of [
  ['HTMLElement', ''],
  ['HTMLInputElement', 'INPUT'],
  ['HTMLTextAreaElement', 'TEXTAREA'],
  ['HTMLSelectElement', 'SELECT'],
  ['HTMLButtonElement', 'BUTTON'],
] as const) {
  if (g[name]) continue;
  g[name] = class {
    static [Symbol.hasInstance](value: unknown) {
      const el = value as El | null;
      return Boolean(el && el.nodeType === 1 && (!tag || el.tagName === tag));
    }
  };
}

const baseCreate = doc.createElement as (tag: string) => El;
doc.createElement = (tag: string) => {
  const el = track(baseCreate(tag), tag);
  created.push(el);
  return el;
};
doc.createElementNS = (ns: string, tag: string) => Object.assign((doc.createElement as (t: string) => El)(tag), { namespaceURI: ns });
doc.createTextNode = (text: string) => ({ nodeType: 3, nodeValue: text, textContent: text, parentNode: null });
track(d.body, 'body');
d.documentElement = track(d.documentElement, 'html');
d.documentElement.appendChild(d.body);
d.activeElement = d.body;
doc.getElementById = (id: string) => descendants(d.documentElement).find((el) => el.getAttribute('id') === id) ?? null;

/** The props React last gave this element (event handlers included). */
export function propsOf(el: El): Record<string, unknown> {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  return key ? (el[key] as Record<string, unknown>) : {};
}

/** Live elements (in the document) that pass `test`. */
export function findAll(test: (el: El) => boolean): El[] {
  return created.filter((el) => el.isConnected && test(el));
}

export function find(test: (el: El) => boolean, what: string): El {
  const el = findAll(test)[0];
  if (!el) throw new Error(`Assertion failed: ${what} is on screen`);
  return el;
}

/** All text under an element. */
export function textOf(el: El): string {
  // React writes a lone text child straight to textContent (no text node).
  if (el.childNodes.length === 0) return typeof el.textContent === 'string' ? el.textContent : '';
  return el.childNodes.map((n) => (n.nodeType === 3 ? String(n.nodeValue ?? '') : textOf(n))).join('');
}

export function activeElement(): El | null {
  return d.activeElement;
}

export const body = d.body;

/** A container in the document for createRoot. */
export function container(): Element {
  const el = (doc.createElement as (tag: string) => El)('div');
  (d.body as unknown as { appendChild: (c: El) => void }).appendChild(el);
  return el as unknown as Element;
}
