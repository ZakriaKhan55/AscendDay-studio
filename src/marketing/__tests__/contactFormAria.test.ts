// CR-06-20: on /contact (marketing/contactForm.ts) a field with a problem points at its error
// bubble (aria-describedby), so a screen reader reads the problem, not the hidden hint; fixing the
// field gives it its hint description back. Runs the real installContactForm on a small element tree.
import { body, type El } from '../../components/__tests__/domTree';
import { installContactForm } from '../contactForm';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const make = (tag: string, attrs: Record<string, string> = {}, ...children: El[]) => {
  const el = (document as unknown as { createElement: (t: string) => El }).createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const child of children) (el as unknown as { appendChild: (c: El) => void }).appendChild(child);
  return el;
};
const field = (id: string, tag: 'input' | 'textarea', hint: boolean) => {
  const control = make(tag, { id, 'aria-describedby': hint ? `${id}-hint` : '' });
  if (!hint) control.removeAttribute('aria-describedby');
  Object.assign(control, { value: '' });
  return make('div', { 'data-field': id }, control, ...(hint ? [make('p', { id: `${id}-hint` })] : []));
};

// The error bubble template (cloned for each problem).
const template = make('template', { 'data-contact-error-template': '' });
Object.assign(template, {
  content: {
    firstElementChild: {
      cloneNode: () => make('div', { class: 'field-error-attached' }, make('span', { class: 'leading-5' })),
    },
  },
});
const form = make(
  'form',
  {},
  field('contact-message', 'textarea', true),
  field('contact-email', 'input', true),
  field('contact-name', 'input', false),
  make('input', { name: 'website' }),
  make('div', { 'data-contact-alert': '' }),
  template,
  make('button', { 'data-contact-submit': '' })
);
(body as unknown as { appendChild: (c: El) => void }).appendChild(form);
installContactForm(form as unknown as HTMLFormElement);

const byId = (id: string) => (document as unknown as { getElementById: (id: string) => El | null }).getElementById(id);
const message = byId('contact-message')!;
const send = () => (form as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent({ type: 'submit', preventDefault: () => undefined });

// Empty message: its problem is shown and read with the field.
send();
eq(message.getAttribute('aria-invalid'), 'true', 'the empty message is marked invalid');
assert(byId('contact-message-error') !== null, 'its error bubble is on the page');
eq(message.getAttribute('aria-describedby'), 'contact-message-error', 'the field is described by its error, not the hidden hint');

// Typing in it clears the problem and gives the hint back.
(form as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent({ type: 'input', target: message });
eq(message.getAttribute('aria-invalid'), null, 'typing clears the problem');
eq(message.getAttribute('aria-describedby'), 'contact-message-hint', 'the hint describes the field again');

// The next problem (email) moves to its own field; the message keeps its hint.
Object.assign(message, { value: 'Hello there' });
send();
const email = byId('contact-email')!;
eq(email.getAttribute('aria-describedby'), 'contact-email-error', 'the email field is described by its error');
eq(message.getAttribute('aria-describedby'), 'contact-message-hint', 'the fixed message field keeps its hint');

console.log('contactFormAria: all passed');
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
