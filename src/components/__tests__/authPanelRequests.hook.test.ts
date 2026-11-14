// AuthPanel (ui/AuthPanel.tsx) requests, rendered with react-dom in the dom harness; Supabase Auth
// answers come from a stubbed fetch the test holds and releases (CodeRabbit, 2026-11-14):
//   CR-03-1 a sign-in still on its way when the screen switches to Create account cannot end the
//           busy state of a guest start begun there, nor show its error there;
//   CR-03-2 a failed "Resend confirmation email" shows its message on the sign-in form (before,
//           the message was set but only the signup choice screen rendered it).
import { container, find, findAll, propsOf, textOf, type El } from './domTree';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200 && !check(); i++) await wait(20);
  assert(check(), what);
}

// Auth requests by path; each is answered when the test says so.
type Held = { path: string; answer: (status: number, body: unknown) => void };
const held: Held[] = [];
(globalThis as unknown as Record<string, unknown>).fetch = (input: string | URL | Request) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (!url.pathname.startsWith('/auth/v1/token') && !url.pathname.startsWith('/auth/v1/signup') && !url.pathname.startsWith('/auth/v1/resend')) {
    return Promise.resolve(new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }));
  }
  return new Promise((resolve) => {
    held.push({
      path: url.pathname,
      answer: (status, body) => resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
    });
  });
};
const take = async (path: string) => {
  await until(() => held.some((h) => h.path === path), `a request to ${path} is on its way`);
  const i = held.findIndex((h) => h.path === path);
  return held.splice(i, 1)[0];
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { AuthPanel } = await import('../ui/AuthPanel');
const WRONG_LOGIN = 'Wrong email or password';
type Mode = 'login' | 'signup';

const root = createRoot(container());
const render = (mode: Mode) =>
  flushSync(() =>
    root.render(
      React.createElement(AuthPanel, {
        mode,
        onDone: () => undefined,
        guestState: { currentUser: null } as never,
        pageLinks: { login: '/login', signup: '/signup', dismiss: '/', navigate: () => undefined },
        title: React.createElement('h1', null, 'Auth'),
      })
    )
  );

const byId = (id: string) => find((el) => el.getAttribute('id') === id, `#${id}`);
const type = (id: string, value: string) => flushSync(() => (propsOf(byId(id)).onChange as (e: unknown) => void)({ target: { value } }));
const submitLogin = () =>
  flushSync(() =>
    (propsOf(find((el) => el.tagName === 'FORM', 'the sign-in form')).onSubmit as (e: unknown) => void)({
      preventDefault: () => undefined,
      currentTarget: { elements: [] },
    })
  );
const buttonWith = (text: string) => find((el) => el.tagName === 'BUTTON' && textOf(el).includes(text), `button "${text}"`);
const onScreen = (text: string) => findAll((el) => textOf(el).includes(text)).length > 0;

// --- CR-03-1 ------------------------------------------------------------------------------
render('login');
await wait();
type('auth-email', 'late@example.com');
type('auth-password', 'wrong-password-1');
submitLogin();
const login = await take('/auth/v1/token');

// The screen switches (link or phone Back) while that sign-in is still out; a guest start begins.
render('signup');
await wait();
const guest = () => buttonWith('Continue as guest');
assert(propsOf(guest()).disabled === false, 'the new screen starts free');
flushSync(() => (propsOf(guest()).onClick as () => void)());
await wait();
assert(propsOf(guest()).disabled === true, 'the guest start is busy');
const guestReq = await take('/auth/v1/signup');

// The old sign-in now fails: the guest start stays busy and its screen shows no sign-in error.
login.answer(400, { code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials', message: 'Invalid login credentials' });
await wait(120);
assert(propsOf(guest()).disabled === true, 'an old request ending does not end the new request’s busy state');
assert(!onScreen(WRONG_LOGIN) && !onScreen('Invalid login'), 'the old sign-in error is not shown on the new screen');

// The guest start's own answer still ends it and shows its own message.
guestReq.answer(429, { code: 'over_request_rate_limit', error_code: 'over_request_rate_limit', msg: 'Request rate limit reached', message: 'Request rate limit reached' });
await until(() => propsOf(guest()).disabled === false, 'the guest start’s own answer ends its busy state');
await until(() => onScreen('Too many guest sign-ins'), 'the guest start shows its own error');

// Control: a sign-in that fails on its own screen shows its error there.
render('login');
await wait();
type('auth-email', 'late@example.com');
type('auth-password', 'wrong-password-1');
submitLogin();
(await take('/auth/v1/token')).answer(400, { code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials', message: 'Invalid login credentials' });
await until(() => onScreen(WRONG_LOGIN), 'a failed sign-in shows its error on its own form');
render('signup');
await wait();

// A sign-in still out when the user leaves and comes back to Sign in: its failure is not shown on
// the fresh form (the screen it was sent from is gone).
render('login');
await wait();
type('auth-email', 'late@example.com');
type('auth-password', 'wrong-password-1');
submitLogin();
const lateLogin = await take('/auth/v1/token');
render('signup');
await wait();
render('login');
await wait();
lateLogin.answer(400, { code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials', message: 'Invalid login credentials' });
await wait(150);
assert(!onScreen(WRONG_LOGIN), 'a sign-in sent from a screen that was left shows no error on the fresh sign-in form');

// --- CR-03-2 ------------------------------------------------------------------------------
render('login');
await wait();
type('auth-email', 'new@example.com');
type('auth-password', 'some-password-1');
submitLogin();
(await take('/auth/v1/token')).answer(400, { code: 'email_not_confirmed', error_code: 'email_not_confirmed', msg: 'Email not confirmed', message: 'Email not confirmed' });
await until(() => findAll((el) => el.tagName === 'BUTTON' && textOf(el).includes('Resend confirmation email')).length > 0, 'the resend button shows');
flushSync(() => (propsOf(buttonWith('Resend confirmation email')).onClick as () => void)());
(await take('/auth/v1/resend')).answer(429, { code: 'over_email_send_rate_limit', error_code: 'over_email_send_rate_limit', msg: 'Email rate limit exceeded', message: 'Email rate limit exceeded' });
await until(() => onScreen('Too many emails right now'), 'the failed resend shows its message on the sign-in form');
const bubble = findAll((el) => textOf(el) === 'Too many emails right now. Try again in about an hour.')[0] as El;
const resendBox = buttonWith('Resend').parentNode as El;
assert(resendBox.contains(bubble), 'the message sits with the resend button');

root.unmount();
console.log('authPanelRequests: all passed');
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
