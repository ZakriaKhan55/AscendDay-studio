// Sign-up when sessionStorage throws (blocked storage, some private modes): auth/auth.ts signUpUser,
// CodeRabbit CR-04-22, 2026-11-14. The first write of the sign-up defaults was guarded, but the
// removals after supabase.auth.signUp were not: a sign-up that worked (email confirmation sent)
// came back as an error, and a captcha refusal lost its CaptchaRejectedError (no fresh-token retry).
// Fake Supabase (harness/fakeSupabase.ts) with /auth/v1/signup answered here.
import { story, assert, eq, pass } from './harness/bootHook';

const g = globalThis as unknown as Record<string, unknown>;
const realFetch = g.fetch as typeof fetch;
let signupAnswer: () => Response = () => new Response('{}', { status: 200 });
g.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/auth/v1/signup')) return Promise.resolve(signupAnswer());
  return realFetch(input, init);
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const throwing = {
  getItem: () => {
    throw new Error('SecurityError: storage blocked');
  },
  setItem: () => {
    throw new Error('SecurityError: storage blocked');
  },
  removeItem: () => {
    throw new Error('SecurityError: storage blocked');
  },
  clear: () => undefined,
  key: () => null,
  length: 0,
};

await story('signUpStorage.hook (sign-up with sessionStorage that throws)', async () => {
  const { signUpUser } = await import('../auth/auth');
  const { CaptchaRejectedError } = await import('../auth/captcha');
  const realSession = g.sessionStorage;
  g.sessionStorage = throwing;
  try {
    // Email confirmation on: the server answers the new user without a session.
    signupAnswer = () => json(200, { id: '22222222-2222-4222-8222-222222222222', email: 'new@test.local', aud: 'authenticated', role: 'authenticated', identities: [{ id: 'x' }] });
    const result = await signUpUser('New@Test.local', 'pw-123456789', 'newperson', '🧑');
    eq(result.type, 'email_confirmation', 'a sign-up that worked is reported as sent, not as an error');
    pass('sign-up with blocked storage still reports the confirmation email');

    // The bot check refused the token: the caller needs CaptchaRejectedError to get a fresh one.
    signupAnswer = () => json(400, { code: 400, error_code: 'captcha_failed', msg: 'captcha protection: request disallowed' });
    let caught: unknown = null;
    try {
      await signUpUser('new@test.local', 'pw-123456789', 'newperson', '🧑', 'token');
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof CaptchaRejectedError, `a captcha refusal stays CaptchaRejectedError (got ${String(caught)})`);
    pass('captcha refusal with blocked storage keeps its own error');
  } finally {
    g.sessionStorage = realSession;
  }
});
