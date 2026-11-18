-- Season tie-key cache (2026-11-18). Order: any time, before or after the app update (the RPC answer
-- keeps its shape: [id, points, activeDays, penaltyPoints, lastEarnedMs]). Not applied.
-- Plan: knowledge/mode-a-season-tie-cache-2026-11-18.md (+ the Mode B notes in work/fix-season-cache/).
--
-- ascend_league_boards computed the Season board's tie keys live on every call:
-- ascend_period_standings(season start, infinity) = a parse of every season row of every member plus a
-- second floored-points scan. Cost is linear in season rows (~12 ms today, ~85 ms by season end, more
-- with members). Now each member's season keys are stored and kept current, and the board reads them.
--
-- 1. Table ascend_season_tie_keys: one row per member (user_id), the season it was computed for, and
--    the values ascend_period_standings(season start, 'infinity', true) gives for that member:
--    points (the floored season sum, = ascend_season_points), active_days, penalty_points,
--    last_earned_at. Server-only (RLS on, no policies, no anon/authenticated grants).
-- 2. ascend_season_keys_refresh(users): recomputes those members' rows from point_entries for the
--    current season. It first locks the members' profile rows (the same rows the existing
--    season_points trigger updates), then computes in a new statement, so two writers for one member
--    run one after the other and the later one sees the earlier one's rows (never a stale overwrite).
--    Per member it reads only that member's season rows (index point_entries_user_awarded_at_idx).
--    Active days are recomputed from the rows (distinct days), so no per-day state is kept.
-- 3. When the keys change, and what refreshes them:
--    - point_entries INSERT / UPDATE: the existing statement trigger point_entries_refresh_season_points
--      (same triggers, body + one call) for the members in changed_rows, after their season_points;
--    - point_entries DELETE (hard deletes: account deletion cascade, manual SQL): new statement trigger,
--      keys only (season_points is untouched, as before);
--    - profiles.timezone change (rows without a day key move days) and a new profile: new row trigger.
--      Not "UPDATE OF timezone": profiles_guard_timezone sets NEW.timezone from device_timezone, and a
--      column trigger only sees the SET list;
--    - season start: ascend_run_season_rollover (already recomputes every season_points) rebuilds all;
--    - anything else (restore with triggers off, ascend_timezones edits): ascend_season_keys_rebuild()
--      (service_role only).
-- 4. ascend_league_boards: the live body (read 2026-11-18, = 20261118120000) with the Season join reading
--    the cache instead of ascend_period_standings. Same rule: keys only when the row is for the current
--    season and its points equal profiles.season_points, else null keys (last in ties, as before).
--    Week and Month (and archives) still use ascend_period_standings, unchanged.
-- 5. Backfill: ascend_season_keys_rebuild() at the end. Writers to point_entries and profiles wait for
--    this migration (the trigger DDL locks both tables until COMMIT), so the backfill sees a still table.
--
-- No point, season_points, archive or grant change for clients. Proof: work/fix-season-cache/
-- (PGlite on a live dump: new Season board = old Season board, then after writes, deletes, timezone
-- change, rollover). Rollback: work/snapshots/fix-season-cache-2026-11-18/rollback.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ascend_season_tie_keys (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  season integer NOT NULL,
  points integer NOT NULL,
  active_days integer NOT NULL,
  penalty_points numeric NOT NULL,
  last_earned_at timestamptz,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ascend_season_tie_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ascend_season_tie_keys FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ascend_season_tie_keys TO service_role;

CREATE OR REPLACE FUNCTION public.ascend_season_keys_refresh(p_users uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_season int := public.ascend_season_number(now());
  v_start  timestamptz := public.ascend_season_begin(v_season);
BEGIN
  IF coalesce(cardinality(p_users), 0) = 0 THEN
    RETURN;
  END IF;

  -- Lock first, compute in the next statement (a new snapshot): a concurrent writer for the same
  -- member holds this lock until it commits, so whoever computes last sees every committed row.
  PERFORM 1 FROM public.profiles p WHERE p.id = ANY (p_users) ORDER BY p.id FOR UPDATE;

  INSERT INTO public.ascend_season_tie_keys AS t
    (user_id, season, points, active_days, penalty_points, last_earned_at, refreshed_at)
  SELECT p.id, v_season, public.ascend_season_points(p.id),
         k.active_days, k.penalty_points, k.last_earned_at, now()
  FROM public.profiles p
  CROSS JOIN LATERAL (SELECT public.ascend_user_timezone(p.id) AS name) tz
  CROSS JOIN LATERAL (
    -- = the keys of ascend_period_standings(v_start, 'infinity', true) for this one member.
    SELECT count(DISTINCT coalesce(e.day_key, ((e.awarded_at AT TIME ZONE tz.name)::date)::text))
             FILTER (WHERE e.positive AND e.src NOT IN ('recovery_milestone', 'addiction_recovery'))::int AS active_days,
           coalesce(sum(-e.amount) FILTER (WHERE e.src IN ('habit_missed', 'bad_habit_no_report')), 0) AS penalty_points,
           max(e.awarded_at) FILTER (WHERE e.positive) AS last_earned_at
    FROM (
      SELECT pe.awarded_at,
             coalesce(pe.data->>'source', '') AS src,
             (pe.data->>'amount' ~ '^[0-9]+(\.[0-9]+)?$' AND (pe.data->>'amount')::numeric > 0) AS positive,
             coalesce((pe.data->>'amount')::numeric, 0) AS amount,
             CASE WHEN pe.data->'metadata'->>'date' ~ '^\d{4}-\d{2}-\d{2}$' THEN pe.data->'metadata'->>'date'
                  WHEN pe.data->'metadata'->>'periodKey' ~ '^\d{4}-\d{2}-\d{2}$' THEN pe.data->'metadata'->>'periodKey'
             END AS day_key
      FROM public.point_entries pe
      WHERE pe.user_id = p.id
        AND pe.deleted_at IS NULL
        AND coalesce(pe.data->>'source', '') <> 'system'
        AND coalesce(pe.data->>'reason', '') <> 'System: Debt Forgiveness'
        AND pe.awarded_at >= v_start
    ) e
  ) k
  WHERE p.id = ANY (p_users)
  ON CONFLICT (user_id) DO UPDATE
    SET season = EXCLUDED.season,
        points = EXCLUDED.points,
        active_days = EXCLUDED.active_days,
        penalty_points = EXCLUDED.penalty_points,
        last_earned_at = EXCLUDED.last_earned_at,
        refreshed_at = EXCLUDED.refreshed_at;
END;
$function$;

REVOKE ALL ON FUNCTION public.ascend_season_keys_refresh(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ascend_season_keys_refresh(uuid[]) TO service_role;

-- Full rebuild (every member, current season). Repair tool and season start; service_role only.
CREATE OR REPLACE FUNCTION public.ascend_season_keys_rebuild()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_count int;
BEGIN
  PERFORM public.ascend_season_keys_refresh(ARRAY(SELECT p.id FROM public.profiles p));
  SELECT count(*)::int INTO v_count FROM public.ascend_season_tie_keys;
  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.ascend_season_keys_rebuild() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ascend_season_keys_rebuild() TO service_role;

-- Existing INSERT / UPDATE statement triggers (unchanged): season_points as before, then the keys.
CREATE OR REPLACE FUNCTION public.point_entries_refresh_season_points()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  UPDATE public.profiles p
     SET season_points = p.season_points
   WHERE p.id IN (SELECT DISTINCT r.user_id FROM changed_rows r);
  -- Season tie keys for the same members (their profile rows are locked by the UPDATE above).
  PERFORM public.ascend_season_keys_refresh(ARRAY(SELECT DISTINCT r.user_id FROM changed_rows r));
  RETURN NULL;
END;
$function$;

-- Hard deletes: keys only.
CREATE OR REPLACE FUNCTION public.point_entries_refresh_season_keys()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.ascend_season_keys_refresh(ARRAY(SELECT DISTINCT r.user_id FROM changed_rows r));
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.point_entries_refresh_season_keys() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS point_entries_refresh_season_keys_del ON public.point_entries;
CREATE TRIGGER point_entries_refresh_season_keys_del
  AFTER DELETE ON public.point_entries
  REFERENCING OLD TABLE AS changed_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.point_entries_refresh_season_keys();

-- A new profile, or a changed timezone (entries without a day key are counted on their local day).
CREATE OR REPLACE FUNCTION public.profiles_refresh_season_keys()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.ascend_season_keys_refresh(ARRAY[NEW.id]);
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.profiles_refresh_season_keys() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_refresh_season_keys_ins ON public.profiles;
CREATE TRIGGER profiles_refresh_season_keys_ins
  AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_refresh_season_keys();

DROP TRIGGER IF EXISTS profiles_refresh_season_keys_tz ON public.profiles;
CREATE TRIGGER profiles_refresh_season_keys_tz
  AFTER UPDATE ON public.profiles
  FOR EACH ROW WHEN (OLD.timezone IS DISTINCT FROM NEW.timezone)
  EXECUTE FUNCTION public.profiles_refresh_season_keys();

-- Season start: the live body (read 2026-11-18) + the keys rebuild after every season_points recompute.
CREATE OR REPLACE FUNCTION public.ascend_run_season_rollover()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_season int := public.ascend_season_number(now());
  v_stored int;
  v_count  int := 0;
BEGIN
  SELECT current_season INTO v_stored FROM public.ascend_season_state WHERE id FOR UPDATE;
  IF v_stored IS NOT NULL AND v_stored >= v_season THEN
    RETURN 0;
  END IF;
  UPDATE public.profiles SET season_points = season_points;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  -- Season tie keys for the new season (also picks up rows written just before the boundary).
  PERFORM public.ascend_season_keys_rebuild();
  INSERT INTO public.ascend_season_state (id, current_season, rolled_at)
  VALUES (true, v_season, now())
  ON CONFLICT (id) DO UPDATE SET current_season = EXCLUDED.current_season, rolled_at = EXCLUDED.rolled_at;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ascend_league_boards(p_types text[] DEFAULT ARRAY['weekly'::text, 'monthly'::text, 'ninetyDay'::text], p_slim boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_now timestamptz := now();
  v_season int := public.ascend_season_number(v_now);
  v_season_start timestamptz := public.ascend_season_begin(v_season);
  v_week timestamp := date_trunc('week', v_now AT TIME ZONE 'UTC');
  v_month timestamp := date_trunc('month', v_now AT TIME ZONE 'UTC');
  v_result jsonb := '{}'::jsonb;
  r record;
BEGIN
  -- Members only, as ascend_member_profiles.
  IF auth.uid() IS NULL THEN
    RETURN v_result;
  END IF;

  FOR r IN
    SELECT k.type, k.period_id,
           greatest(k.s AT TIME ZONE 'UTC', v_season_start) AS score_start,
           k.e AT TIME ZONE 'UTC' AS period_end
    FROM (VALUES
      ('weekly', 'W:' || to_char(v_week, 'IYYY') || '-W' || to_char(v_week, 'IW'), v_week, v_week + interval '7 days'),
      ('monthly', 'M:' || to_char(v_month, 'YYYY-MM'), v_month, v_month + interval '1 month')
    ) AS k(type, period_id, s, e)
    WHERE k.type = ANY (p_types)
  LOOP
    v_result := v_result || jsonb_build_object(r.type,
      jsonb_build_object(
        'period_id', r.period_id,
        -- [member id, points, active days, penalty points, last earned (epoch ms)] for members with
        -- points (0 dropped), best first, ties as ascend_league_archive_rows.
        'points', coalesce((
          SELECT jsonb_agg(jsonb_build_array(p.id, ps.points, ps.active_days, ps.penalty_points,
                                             public.ascend_epoch_ms(ps.last_earned_at))
                           ORDER BY ps.points DESC, ps.active_days DESC, ps.penalty_points ASC,
                                    ps.last_earned_at ASC NULLS LAST,
                                    md5(r.period_id || ':' || p.id::text) COLLATE "C")
          FROM public.ascend_period_standings(r.score_start, r.period_end, false) ps
          JOIN public.profiles p ON p.id = ps.user_id
        ), '[]'::jsonb)
      ));
  END LOOP;

  -- Season points (profiles.season_points, kept current by the point_entries triggers) on slim calls
  -- too, so the live poll moves the Season board with Week and Month. Tie keys from
  -- ascend_season_tie_keys (kept current by the same triggers; = ascend_period_standings over the
  -- window of ascend_season_points); null keys if the row is for another season or disagrees with
  -- season_points.
  IF 'ninetyDay' = ANY (p_types) THEN
    v_result := v_result || jsonb_build_object('ninetyDay', jsonb_build_object(
      'period_id', 'S:' || v_season,
      'points', coalesce((
        SELECT jsonb_agg(jsonb_build_array(p.id, p.season_points, ps.active_days, ps.penalty_points,
                                           public.ascend_epoch_ms(ps.last_earned_at))
                         ORDER BY p.season_points DESC, ps.active_days DESC NULLS LAST,
                                  ps.penalty_points ASC NULLS LAST, ps.last_earned_at ASC NULLS LAST,
                                  md5('S:' || v_season || ':' || p.id::text) COLLATE "C")
        FROM public.profiles p
        LEFT JOIN public.ascend_season_tie_keys ps
          ON ps.user_id = p.id AND ps.season = v_season AND ps.points = p.season_points
        WHERE coalesce(p.season_points, 0) <> 0
      ), '[]'::jsonb)
    ));
  END IF;

  IF p_slim THEN
    RETURN v_result;
  END IF;

  -- Every member, with whether they were active in the last 7 days (the live table shows members
  -- with points plus active members with 0; only members with points are ranked and counted).
  v_result := v_result || jsonb_build_object('members', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', p.id,
             'uid', p.uid::text,
             'username', p.username,
             'avatar', p.avatar,
             'is_profile_public', p.is_profile_public,
             'accept_partner_invites', p.accept_partner_invites,
             'active', a.active,
             -- Active members' first activity in each board's period (epoch ms, null if none yet):
             -- members with 0 points are listed in that order, first come first.
             'first_active', CASE WHEN a.active THEN jsonb_build_object(
               'weekly', public.ascend_epoch_ms(public.ascend_user_first_active_since(p.id, greatest(v_week AT TIME ZONE 'UTC', v_season_start))),
               'monthly', public.ascend_epoch_ms(public.ascend_user_first_active_since(p.id, greatest(v_month AT TIME ZONE 'UTC', v_season_start))),
               'ninetyDay', public.ascend_epoch_ms(public.ascend_user_first_active_since(p.id, v_season_start))) END)
           ORDER BY lower(p.username) COLLATE "C", p.id::text COLLATE "C")
    FROM public.profiles p
    CROSS JOIN LATERAL (
      SELECT public.ascend_user_active_between(p.id, v_now - interval '7 days', v_now) AS active
    ) a
  ), '[]'::jsonb));

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.ascend_league_boards(text[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ascend_league_boards(text[], boolean) TO authenticated, service_role;

-- Backfill (every member, current season).
SELECT public.ascend_season_keys_rebuild();

COMMIT;
