-- League tie-break (2026-11-18). Order: any time, before or after the app update (old apps ignore the
-- extra row values). Not applied. Plan: knowledge/mode-a-league-tiebreak-2026-11-18.md.
--
-- Members with equal points in a league period (week, month, season) were ordered by username A-Z.
-- Now, best first:
--   1. points, more first (unchanged);
--   2. more active days: distinct user-local days with at least one positive entry in the period,
--      recovery_milestone and addiction_recovery not counted (the entry rule of
--      ascend_user_active_between; sign-ins do not count). The day is the entry's metadata day key
--      (metadata.date, else metadata.periodKey, when it is a YYYY-MM-DD date), else the local day of
--      awarded_at in the member's timezone (weekly, lesson and bonus rows have no day key);
--   3. fewer penalty points: raw (not floored) sum of habit_missed and bad_habit_no_report in the period
--      (only the automatic penalties; self-reported slips and admin fixes are not counted);
--   4. reached first: the latest awarded_at among the member's positive entries in the period, earlier
--      wins (penalties are not counted);
--   5. last: md5(period id || ':' || member id), so no member wins every exact tie.
-- No shared rank. Usernames no longer decide order (the members list stays A-Z).
--
-- 1. New ascend_period_standings(start, end, inclusive_end): ascend_period_points (same rows, filters,
--    window and floored points, members with 0 dropped) plus the three keys. Read-only (STABLE),
--    caller's rights like ascend_period_points, not callable by clients.
-- 2. ascend_league_archive_rows: the live body (read 2026-11-18, = 20261017060000) with the standings
--    from (1) in the new order. Same signature, columns and archive JSON. Only archives not yet final
--    can be rewritten (ascend_run_league_archives skips final periods and its upsert never touches a
--    final row), so a provisional archive (period ended < 48 h ago) with a tie may change order once.
-- 3. ascend_league_boards: the live body (read 2026-11-18, = 20261107100000) with each weekly, monthly
--    and season row [id, points, activeDays, penaltyPoints, lastEarnedMs] in the new order (was
--    [id, points] by name). App 1.4.1 reads only row[0] and row[1]. Season points still come from
--    profiles.season_points; the season keys use the same window as ascend_season_points (season
--    start, no end), computed live on each call (no cache yet). lastEarnedMs is epoch ms or null.
--    Mirror: src/lib/leagues/leagues.ts compareCompetitors (the last step there is the server order).
-- No table, column, trigger, grant or point change. Rollback: re-run the two bodies saved in
-- work/snapshots/league-tiebreak-2026-11-18/ and drop ascend_period_standings.

CREATE OR REPLACE FUNCTION public.ascend_period_standings(p_start timestamptz, p_end timestamptz, p_inclusive_end boolean)
 RETURNS TABLE(user_id uuid, points integer, active_days integer, penalty_points numeric, last_earned_at timestamptz)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  WITH e AS MATERIALIZED (
    SELECT pe.user_id, pe.awarded_at,
           coalesce(pe.data->>'source', '') AS src,
           -- Positive as ascend_user_active_between counts it (a numeric amount above 0).
           (pe.data->>'amount' ~ '^[0-9]+(\.[0-9]+)?$' AND (pe.data->>'amount')::numeric > 0) AS positive,
           coalesce((pe.data->>'amount')::numeric, 0) AS amount,
           CASE WHEN pe.data->'metadata'->>'date' ~ '^\d{4}-\d{2}-\d{2}$' THEN pe.data->'metadata'->>'date'
                WHEN pe.data->'metadata'->>'periodKey' ~ '^\d{4}-\d{2}-\d{2}$' THEN pe.data->'metadata'->>'periodKey'
           END AS day_key
    FROM public.point_entries pe
    WHERE pe.deleted_at IS NULL
      AND coalesce(pe.data->>'source', '') <> 'system'
      AND coalesce(pe.data->>'reason', '') <> 'System: Debt Forgiveness'
      AND pe.awarded_at >= p_start
      AND pe.awarded_at <= p_end
      AND (pe.awarded_at < p_end OR p_inclusive_end)
  ), tz AS (
    SELECT u.user_id, public.ascend_user_timezone(u.user_id) AS name
    FROM (SELECT DISTINCT e.user_id FROM e) u
  ), k AS (
    SELECT e.user_id,
           count(DISTINCT coalesce(e.day_key, ((e.awarded_at AT TIME ZONE tz.name)::date)::text))
             FILTER (WHERE e.positive AND e.src NOT IN ('recovery_milestone', 'addiction_recovery'))::int AS active_days,
           coalesce(sum(-e.amount) FILTER (WHERE e.src IN ('habit_missed', 'bad_habit_no_report')), 0) AS penalty_points,
           max(e.awarded_at) FILTER (WHERE e.positive) AS last_earned_at
    FROM e JOIN tz ON tz.user_id = e.user_id
    GROUP BY e.user_id
  )
  SELECT pp.user_id, pp.points, coalesce(k.active_days, 0), coalesce(k.penalty_points, 0), k.last_earned_at
  FROM public.ascend_period_points(p_start, p_end, p_inclusive_end) pp
  LEFT JOIN k ON k.user_id = pp.user_id;
$function$;

REVOKE ALL ON FUNCTION public.ascend_period_standings(timestamptz, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ascend_period_standings(timestamptz, timestamptz, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.ascend_league_archive_rows(p_period_id text, p_score_start timestamp with time zone, p_period_end timestamp with time zone, p_inclusive_end boolean, p_type text, p_label text, p_season integer, p_final boolean, p_archived_at timestamp with time zone)
 RETURNS TABLE(user_id uuid, data jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  WITH standings AS (
    SELECT pr.id, pr.uid::text AS uid, pr.username, coalesce(pr.avatar, '🧑') AS avatar, ps.points,
           -- Tie-break: more active days, fewer penalty points, reached first, then a per-period hash.
           row_number() OVER (ORDER BY ps.points DESC, ps.active_days DESC, ps.penalty_points ASC,
                                       ps.last_earned_at ASC NULLS LAST,
                                       md5(p_period_id || ':' || pr.id::text) COLLATE "C") AS pos
    FROM public.ascend_period_standings(p_score_start, p_period_end, p_inclusive_end) ps
    JOIN public.profiles pr ON pr.id = ps.user_id
  )
  SELECT me.id,
         jsonb_strip_nulls(jsonb_build_object(
           'id', p_period_id,
           'type', p_type,
           'periodLabel', p_label,
           'seasonNumber', p_season,
           'competitors', (
             SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                      'id', c.id, 'uid', c.uid, 'name', c.username, 'avatar', c.avatar,
                      'points', c.points, 'totalPoints', 0, 'isRealUser', true,
                      'isUser', CASE WHEN c.id = me.id THEN true END
                    )) ORDER BY c.pos)
             FROM standings c),
           'userRank', me.pos,
           'userPoints', me.points,
           'archivedAt', to_char(p_archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'scoreSource', 'ledger',
           'source', 'server',
           'final', p_final
         ))
  FROM standings me;
$function$;

REVOKE ALL ON FUNCTION public.ascend_league_archive_rows(text, timestamptz, timestamptz, boolean, text, text, integer, boolean, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ascend_league_archive_rows(text, timestamptz, timestamptz, boolean, text, text, integer, boolean, timestamptz)
  TO service_role;

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
  -- too, so the live poll moves the Season board with Week and Month. Tie keys over the window of
  -- ascend_season_points (season start, no end); null keys if they disagree with season_points.
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
        LEFT JOIN public.ascend_period_standings(v_season_start, 'infinity'::timestamptz, true) ps
          ON ps.user_id = p.id AND ps.points = p.season_points
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
