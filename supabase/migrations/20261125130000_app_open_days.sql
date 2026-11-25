-- PWA install, measurement (2026-11-25). Order: any time BEFORE the studio test of the app update that
-- calls it (BEFORE-safe: new objects only; older app builds never call the RPC).
-- Plan: knowledge/mode-a-pwa-install-2026-11-25.md §4.
--
-- One row per account per UTC day per mode ('browser' tab or installed 'standalone' app) per platform
-- (ios, android, desktop, other), so "active days in the app vs in the browser" can be compared later.
-- The app never writes the table: it calls ascend_note_app_open once per day per mode; the server
-- stamps the account, the day and the time. Members read only their own rows.
--
-- Not in the 30-day ascend_purge_old_logs rule on purpose (Zakria 2026-11-25): retention needs the
-- longer history and the rows are tiny (at most a few per account per day). Not soft-deleted, not
-- synced, not in the realtime publication. No index beyond the primary key.
-- Account delete (and guest cleanup) removes the rows through the auth.users cascade.
--
-- Rollback: DROP FUNCTION public.ascend_note_app_open(text, text); DROP TABLE public.app_open_days;

CREATE TABLE public.app_open_days (
  user_id  uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  day      date NOT NULL,
  mode     text NOT NULL CHECK (mode IN ('browser', 'standalone')),
  platform text NOT NULL CHECK (platform IN ('ios', 'android', 'desktop', 'other')),
  first_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day, mode, platform)
);

ALTER TABLE public.app_open_days ENABLE ROW LEVEL SECURITY;

-- Explicit grants: read own rows only; no INSERT/UPDATE/DELETE for members (writes go through the RPC).
REVOKE ALL ON public.app_open_days FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.app_open_days TO authenticated;
GRANT ALL ON public.app_open_days TO service_role;

CREATE POLICY app_open_days_owner_read ON public.app_open_days
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- Records that the signed-in account opened AscendDay today (UTC) in this mode on this platform.
-- Idempotent: a second call the same day is a no-op.
CREATE OR REPLACE FUNCTION public.ascend_note_app_open(p_mode text, p_platform text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('browser', 'standalone')
     OR p_platform IS NULL OR p_platform NOT IN ('ios', 'android', 'desktop', 'other') THEN
    RAISE EXCEPTION 'bad value' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.app_open_days (user_id, day, mode, platform)
  VALUES (v_user, (pg_catalog.now() AT TIME ZONE 'UTC')::date, p_mode, p_platform)
  ON CONFLICT DO NOTHING;
END;
$function$;

REVOKE ALL ON FUNCTION public.ascend_note_app_open(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ascend_note_app_open(text, text) TO authenticated, service_role;
