-- League tie-break step 3 (fewer penalty points) also counts self-reported slips
-- (source 'bad_habit_occurred'), Zakria 2026-11-28. Before: only server-issued penalties
-- ('habit_missed', 'bad_habit_no_report'). Same signatures, so no overloads to drop; grants kept.
-- Both functions must keep the same penalty filter (season tie keys = ascend_period_standings keys).

CREATE OR REPLACE FUNCTION public.ascend_period_standings(p_start timestamp with time zone, p_end timestamp with time zone, p_inclusive_end boolean)
 RETURNS TABLE(user_id uuid, points integer, active_days integer, penalty_points numeric, last_earned_at timestamp with time zone)
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
           END AS day_key,
           -- When an award row's amount last rose (data.gainedAt, ascend_award_gained_at); null for other rows.
           CASE WHEN pe.data ? 'gainedAt' THEN public.ascend_instant(pe.data->>'gainedAt') END AS gained_at
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
           coalesce(sum(-e.amount) FILTER (WHERE e.src IN ('habit_missed', 'bad_habit_no_report', 'bad_habit_occurred')), 0) AS penalty_points,
           -- Last earning: the row's time, or its last rise when later, a rise counted no later than the period's end.
           -- (least/greatest skip nulls, so a row without gainedAt must give null here, not the period's end.)
           max(greatest(e.awarded_at,
                        CASE WHEN e.gained_at IS NOT NULL
                             THEN least(e.gained_at, CASE WHEN p_inclusive_end THEN p_end ELSE p_end - interval '1 millisecond' END) END))
             FILTER (WHERE e.positive) AS last_earned_at
    FROM e JOIN tz ON tz.user_id = e.user_id
    GROUP BY e.user_id
  )
  SELECT pp.user_id, pp.points, coalesce(k.active_days, 0), coalesce(k.penalty_points, 0), k.last_earned_at
  FROM public.ascend_period_points(p_start, p_end, p_inclusive_end) pp
  LEFT JOIN k ON k.user_id = pp.user_id;
$function$
;

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
           coalesce(sum(-e.amount) FILTER (WHERE e.src IN ('habit_missed', 'bad_habit_no_report', 'bad_habit_occurred')), 0) AS penalty_points,
           max(greatest(e.awarded_at, e.gained_at)) FILTER (WHERE e.positive) AS last_earned_at
    FROM (
      SELECT pe.awarded_at,
             coalesce(pe.data->>'source', '') AS src,
             (pe.data->>'amount' ~ '^[0-9]+(\.[0-9]+)?$' AND (pe.data->>'amount')::numeric > 0) AS positive,
             coalesce((pe.data->>'amount')::numeric, 0) AS amount,
             CASE WHEN pe.data->'metadata'->>'date' ~ '^\d{4}-\d{2}-\d{2}$' THEN pe.data->'metadata'->>'date'
                  WHEN pe.data->'metadata'->>'periodKey' ~ '^\d{4}-\d{2}-\d{2}$' THEN pe.data->'metadata'->>'periodKey'
             END AS day_key,
             CASE WHEN pe.data ? 'gainedAt' THEN public.ascend_instant(pe.data->>'gainedAt') END AS gained_at
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
$function$
;

-- Recompute cached season tie keys with the new rule.
SELECT public.ascend_season_keys_refresh(ARRAY(SELECT p.id FROM public.profiles p));
