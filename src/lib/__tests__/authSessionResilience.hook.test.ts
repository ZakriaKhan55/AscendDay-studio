// Account load edge cases in auth/authSession.ts (CodeRabbit 2026-11-14), against the fake Supabase:
//   CR-04-25  no user_data row but rows in the synced tables: the rows still load (before: the
//             empty-account branch dropped them, so saved habits vanished for that session).
//   CR-04-23  the private profile read (ascend_my_profile) fails: the notification switches keep
//             this device's last known values (before: all three showed On).
//   CR-04-24  the profile insert loses to another tab (profiles_pkey): the stored row's uid and name
//             are used (before: this tab's own random uid, which other members cannot find).
// The app boots signed in first (bootHook), then each case calls the load functions directly.
import { bootHook, story, until, eq, assert, pass, fake, server, habit, seedServerHabits, UID } from './harness/bootHook';
import { EMAIL } from './harness/fakeSupabase';

const g = globalThis as unknown as Record<string, unknown>;
const CACHE_KEY = `ascend_user_cache_${UID}`;

await story('authSessionResilience.hook (account load edge cases)', async () => {
  seedServerHabits(habit('h-saved', 'Saved on another device'));
  const h = await bootHook({ as: 'signedIn' });
  await until(h.loaded, 'signed-in boot loaded');
  const { hydrateUserSession, fetchProfileForUser } = await import('../auth/authSession');

  // CR-04-25: the settings row is gone and this device has no copy; the habits table still has a row.
  server.blob.delete(UID);
  h.storage.removeItem(CACHE_KEY);
  const noRow = await hydrateUserSession(UID, EMAIL, null);
  assert(
    (noRow.state.habits || []).some((x: { id: string }) => x.id === 'h-saved'),
    `CR-04-25: the table's habit loads without a user_data row (got ${JSON.stringify((noRow.state.habits || []).map((x: { id: string }) => x.id))})`
  );
  pass('CR-04-25 table rows load when the user_data row is missing');

  // CR-04-23: this device last saw two switches off; the private read now fails.
  h.storage.setItem(
    CACHE_KEY,
    JSON.stringify({
      currentUser: { id: UID, notifDailyReminder: false, notifPartnerActivity: false, notifSundayPlanning: true, lastUsernameChangeAt: '2026-11-01T00:00:00.000Z' },
    })
  );
  fake.fail('rpc/ascend_my_profile', 500);
  const prof = await fetchProfileForUser(UID);
  fake.unfail('rpc/ascend_my_profile');
  eq(prof.error, null, 'CR-04-23: the public row still loads');
  eq(prof.data?.notif_daily_reminder, false, 'CR-04-23: daily reminder stays off');
  eq(prof.data?.notif_partner_activity, false, 'CR-04-23: partner activity stays off');
  eq(prof.data?.last_username_change_at, '2026-11-01T00:00:00.000Z', 'CR-04-23: last username change kept');
  eq(prof.data?.uid, '424242', 'CR-04-23: public columns still come from the row');
  pass('CR-04-23 a failed private read keeps the last known switches');

  // CR-04-24: no profile row at the read; another tab inserts it (uid 777777) just before this one.
  const profiles = server.g('profiles');
  const original = profiles.splice(profiles.findIndex((p: { id: string }) => p.id === UID), 1)[0];
  const realFetch = g.fetch as typeof fetch;
  g.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'POST' && /\/rest\/v1\/profiles(\?|$)/.test(url)) {
      profiles.push({ ...original, uid: '777777', username: 'othertab' });
      return new Response(JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint "profiles_pkey"' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(input, init);
  };
  let lost: Awaited<ReturnType<typeof hydrateUserSession>>;
  try {
    lost = await hydrateUserSession(UID, EMAIL, null);
  } finally {
    g.fetch = realFetch;
  }
  eq(lost.user.uid, '777777', 'CR-04-24: the stored uid is used');
  eq(lost.user.username, 'othertab', 'CR-04-24: the stored username is used');
  eq(h.storage.getItem(`ascend_uid_${UID}`), '777777', 'CR-04-24: the cached uid follows the stored row');
  pass('CR-04-24 a lost profile insert uses the stored row');
});
