-- "Reached first" stamp: data.gainedAt on award rows (2026-11-18). Order: AFTER 20261118132000 (applied
-- 2026-11-18 15:27 PKT); any time before or after the app update. Not applied.
-- Plan: knowledge/mode-a-award-rewrites-2026-11-18.md §4; notes: knowledge/mode-b-gained-at-2026-11-18.md.
--
-- The league tie-break's last step ("reached first" = earlier last earning) read max(awarded_at) over a
-- member's positive rows. The workout, skill, reading, focus and time tracker award rows are one row per
-- day that keeps its first time when a later log raises its amount, so the last earning read too early.
-- awarded_at must not move (points are floored at 0 in awarded_at order, and a row's awarded_at decides its
-- league period), so the rise gets its own stamp:
--
-- 1. ascend_award_gained_at(live row, new amount): now (UTC ISO, the data.timestamp format) when the live
--    row exists and the new amount is higher; else the live row's own gainedAt; else null (new row,
--    revived row, or never raised). Server-only helper.
-- 2. The 5 award functions (live bodies read 2026-11-18, reading = 20261118131000) add
--    "gainedAt": <that> to data when it is not null. Nothing else changes: same amount, reason, metadata,
--    timestamp (so awarded_at, totals, floors and period placement are untouched); a write that changed
--    nothing before still changes nothing (gainedAt is kept as it was). Same signatures, no new overloads.
-- 3. ascend_period_standings: last_earned_at = max(greatest(awarded_at, gainedAt clamped to the period's
--    end)) over positive rows. ascend_season_keys_refresh (the Season cache): the same over the season.
--    Boards, archives and the Season cache read these two, so they pick it up; nothing else changes.
--    A malformed gainedAt is ignored (ascend_instant returns null).
--
-- No row is rewritten here (no backfill): every live row has no gainedAt, so every board, archive and
-- cache row stays the same until an award rises after this is applied. Only the order of members tied on
-- points, active days and penalty points can differ later; points never.
-- Proof: work/fix-gained-at/ (PGlite on live schema, bodies and data). Rollback:
-- work/snapshots/fix-gained-at-2026-11-18/rollback.sql.

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.ascend_season_tie_keys') IS NULL THEN
    RAISE EXCEPTION 'apply 20261118132000_season_tie_keys_cache.sql first';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.ascend_award_gained_at(p_kept jsonb, p_amount numeric)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN p_kept IS NULL THEN NULL -- new or revived row: its own time is its first earning
    WHEN jsonb_typeof(p_kept->'amount') = 'number' AND p_amount > (p_kept->>'amount')::numeric
      THEN to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    WHEN jsonb_typeof(p_kept->'gainedAt') = 'string' THEN p_kept->>'gainedAt'
  END;
$function$;

REVOKE ALL ON FUNCTION public.ascend_award_gained_at(jsonb, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ascend_award_gained_at(jsonb, numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.ascend_recompute_workout_awards(p_user uuid, p_day date, p_tz text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_key       text        := to_char(p_day, 'YYYY-MM-DD');
  v_day_start timestamptz := p_day::timestamp AT TIME ZONE p_tz;
  v_day_end   timestamptz := (p_day + 1)::timestamp AT TIME ZONE p_tz;
  v_cap       numeric     := 10; -- WORKOUT_POINTS.dailyCap
  v_used      numeric     := 0;
  v_count     int         := 0;
  v_first     timestamptz;
  v_kept      text;
  v_kept_row  jsonb;
  v_at        timestamptz;
  v_id        text        := 'workout_award_' || to_char(p_day, 'YYYY-MM-DD');
  v_item      record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('workout_awards:' || p_user::text || ':' || v_key));

  FOR v_item IN
    SELECT public.ascend_workout_points(w.data) AS points,
           public.ascend_instant(w.data->>'createdAt') AS logged_at
    FROM public.workouts w
    WHERE w.user_id = p_user
      AND w.deleted_at IS NULL
      AND w.data->>'date' = v_key
    ORDER BY 2 NULLS LAST, w.id COLLATE "C"
  LOOP
    v_count := v_count + 1;
    v_used := v_used + least(v_item.points, greatest(v_cap - v_used, 0));
    IF v_first IS NULL AND v_used > 0 THEN
      v_first := coalesce(v_item.logged_at, now());
    END IF;
  END LOOP;

  IF v_used > 0 THEN
    SELECT pe.data->>'timestamp', pe.data INTO v_kept, v_kept_row
    FROM public.point_entries pe
    WHERE pe.user_id = p_user AND pe.id = v_id AND pe.deleted_at IS NULL;
    v_at := least(greatest(v_first, v_day_start), now());
    INSERT INTO public.point_entries AS pe (user_id, id, data, created_at, updated_at)
    VALUES (p_user, v_id, jsonb_build_object(
      'id', v_id,
      'amount', v_used::int,
      'reason', 'Workouts logged (' || v_count || ')',
      'source', 'exercise',
      'timestamp', coalesce(v_kept, to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      'metadata', jsonb_build_object('date', v_key, 'workouts', v_count)
    ) || jsonb_strip_nulls(jsonb_build_object('gainedAt', public.ascend_award_gained_at(v_kept_row, v_used::int))), now(), now())
    ON CONFLICT (user_id, id) DO UPDATE
      SET data = EXCLUDED.data, deleted_at = NULL, updated_at = greatest(now(), pe.updated_at)
      WHERE pe.data IS DISTINCT FROM EXCLUDED.data OR pe.deleted_at IS NOT NULL;
  ELSE
    UPDATE public.point_entries pe
    SET deleted_at = now(), updated_at = greatest(now(), pe.updated_at)
    WHERE pe.user_id = p_user AND pe.id = v_id AND pe.deleted_at IS NULL;
  END IF;

  UPDATE public.point_entries pe
  SET deleted_at = now(), updated_at = greatest(now(), pe.updated_at)
  WHERE pe.user_id = p_user
    AND pe.deleted_at IS NULL
    AND pe.id NOT LIKE 'workout\_award\_%'
    AND pe.data->>'source' = 'exercise'
    AND jsonb_typeof(pe.data->'amount') = 'number'
    AND (pe.data->>'amount')::numeric > 0
    AND public.ascend_instant(pe.data->>'timestamp') >= v_day_start
    AND public.ascend_instant(pe.data->>'timestamp') < v_day_end;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.ascend_recompute_skill_awards(p_user uuid, p_day date, p_tz text, p_floor boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_key       text        := to_char(p_day, 'YYYY-MM-DD');
  v_day_start timestamptz := p_day::timestamp AT TIME ZONE p_tz;
  v_day_end   timestamptz := (p_day + 1)::timestamp AT TIME ZONE p_tz;
  v_cap       numeric     := 10; -- SKILLS_POINTS.dailyCap
  v_used      numeric     := 0;
  v_count     int         := 0;
  v_first     timestamptz;
  v_kept      text;
  v_kept_row  jsonb;
  v_kept_amt  numeric;
  v_at        timestamptz;
  v_id        text        := 'skill_award_' || to_char(p_day, 'YYYY-MM-DD');
  v_item      record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('skill_awards:' || p_user::text || ':' || v_key));

  FOR v_item IN
    SELECT public.ascend_skill_session_points(l.data) AS points,
           public.ascend_instant(l.data->>'createdAt') AS logged_at
    FROM public.skill_logs l
    WHERE l.user_id = p_user
      AND l.deleted_at IS NULL
      AND l.data->>'date' = v_key
      AND EXISTS (
        SELECT 1 FROM public.skills s
        WHERE s.user_id = p_user AND s.id = l.data->>'skillId' AND s.deleted_at IS NULL
      )
    ORDER BY 2 NULLS LAST, l.id COLLATE "C"
  LOOP
    v_count := v_count + 1;
    v_used := v_used + least(v_item.points, greatest(v_cap - v_used, 0));
    IF v_first IS NULL AND v_used > 0 THEN
      v_first := coalesce(v_item.logged_at, now());
    END IF;
  END LOOP;

  SELECT pe.data->>'timestamp',
         CASE WHEN jsonb_typeof(pe.data->'amount') = 'number' THEN (pe.data->>'amount')::numeric END,
         pe.data
  INTO v_kept, v_kept_amt, v_kept_row
  FROM public.point_entries pe
  WHERE pe.user_id = p_user AND pe.id = v_id AND pe.deleted_at IS NULL;

  IF p_floor AND v_used <= coalesce(v_kept_amt, 0) THEN
    RETURN; -- an earlier day never drops
  END IF;

  IF v_used > 0 THEN
    v_at := least(greatest(v_first, v_day_start), now(), v_day_end - interval '1 millisecond');
    INSERT INTO public.point_entries AS pe (user_id, id, data, created_at, updated_at)
    VALUES (p_user, v_id, jsonb_build_object(
      'id', v_id,
      'amount', v_used::int,
      'reason', 'Skill practice (' || v_count || ')',
      'source', 'skill',
      'timestamp', coalesce(v_kept, to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      'metadata', jsonb_build_object('date', v_key, 'sessions', v_count)
    ) || jsonb_strip_nulls(jsonb_build_object('gainedAt', public.ascend_award_gained_at(v_kept_row, v_used::int))), now(), now())
    ON CONFLICT (user_id, id) DO UPDATE
      SET data = EXCLUDED.data, deleted_at = NULL, updated_at = greatest(now(), pe.updated_at)
      WHERE pe.data IS DISTINCT FROM EXCLUDED.data OR pe.deleted_at IS NOT NULL;
  ELSE
    UPDATE public.point_entries pe
    SET deleted_at = now(), updated_at = greatest(now(), pe.updated_at)
    WHERE pe.user_id = p_user AND pe.id = v_id AND pe.deleted_at IS NULL;
  END IF;

  IF p_floor THEN
    RETURN; -- never takes anything away from an earlier day
  END IF;

  UPDATE public.point_entries pe
  SET deleted_at = now(), updated_at = greatest(now(), pe.updated_at)
  WHERE pe.user_id = p_user
    AND pe.deleted_at IS NULL
    AND pe.id NOT LIKE 'skill\_award\_%'
    AND pe.data->>'source' = 'skill'
    AND jsonb_typeof(pe.data->'amount') = 'number'
    AND (pe.data->>'amount')::numeric > 0
    AND public.ascend_instant(pe.data->>'timestamp') >= v_day_start
    AND public.ascend_instant(pe.data->>'timestamp') < v_day_end;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.ascend_recompute_reading_awards(p_user uuid, p_day date, p_tz text, p_floor boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_key       text        := to_char(p_day, 'YYYY-MM-DD');
  v_day_start timestamptz := p_day::timestamp AT TIME ZONE p_tz;
  v_day_end   timestamptz := (p_day + 1)::timestamp AT TIME ZONE p_tz;
  v_pages     numeric     := 0;
  v_count     int         := 0;
  v_used      int;
  v_first     timestamptz;
  v_kept      text;
  v_kept_row  jsonb;
  v_kept_amt  numeric;
  v_at        timestamptz;
  v_id        text        := 'reading_award_' || to_char(p_day, 'YYYY-MM-DD');
  v_item      record;
  v_books     jsonb       := '{}'::jsonb; -- per book: running total "t", best "b", owed "d", in pages
  v_total     numeric;
  v_owed      numeric;
  v_best      numeric;
  v_new_best  numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('reading_awards:' || p_user::text || ':' || v_key));

  FOR v_item IN
    SELECT ev.kind, ev.book_id, ev.pages, ev.logged_at
    FROM (
      SELECT 0 AS kind,
             b.id AS book_id,
             l.id AS ord_id,
             -- What the log counts (ascend_reading_log_counted: the same-place rule, in the log's unit),
             -- in pages: a chapter log in whole tenths of a chapter, 2 pages each.
             CASE WHEN (CASE WHEN lower(l.data->>'unit') IN ('pages', 'chapters') THEN lower(l.data->>'unit')
                             ELSE lower(b.data->>'unit') END) = 'chapters'
                  THEN round(coalesce(c.amount, public.ascend_reading_log_pages(l.data)) * 10) * 2
                  ELSE coalesce(c.amount, public.ascend_reading_log_pages(l.data)) END AS pages,
             public.ascend_instant(l.data->>'createdAt') AS logged_at
      FROM public.reading_logs l
      JOIN public.reading_books b
        ON b.user_id = l.user_id AND b.id = l.data->>'bookId' AND b.deleted_at IS NULL
      LEFT JOIN public.ascend_reading_log_counted(p_user, v_key, v_key) c ON c.log_id = l.id
      WHERE l.user_id = p_user
        AND l.deleted_at IS NULL
        AND l.data->>'date' = v_key
        AND (l.data->>'finish') IS DISTINCT FROM 'true'
      UNION ALL
      SELECT 1,
             b.id,
             b.id || '#' || s.ord,
             (s.e->>'pagesAfter')::numeric - (s.e->>'pagesBefore')::numeric,
             public.ascend_instant(s.e->>'at')
      FROM public.reading_books b
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(b.data->'unitSwitches') = 'array' THEN b.data->'unitSwitches' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS s(e, ord)
      WHERE b.user_id = p_user
        AND b.deleted_at IS NULL
        AND jsonb_typeof(s.e) = 'object'
        AND s.e->>'date' = v_key
        AND jsonb_typeof(s.e->'pagesBefore') = 'number'
        AND jsonb_typeof(s.e->'pagesAfter') = 'number'
    ) ev
    ORDER BY ev.logged_at NULLS LAST, ev.kind, ev.ord_id COLLATE "C"
  LOOP
    v_total := coalesce((v_books->v_item.book_id->>'t')::numeric, 0);
    v_best := coalesce((v_books->v_item.book_id->>'b')::numeric, 0);
    v_owed := coalesce((v_books->v_item.book_id->>'d')::numeric, 0);
    IF v_item.kind = 0 OR v_item.pages < 0 THEN
      v_total := v_total + v_item.pages;
    ELSE
      v_total := v_total + least(v_item.pages, v_owed); -- a raising switch only gives back what is owed
    END IF;
    IF v_item.kind = 1 THEN
      v_owed := greatest(v_owed - v_item.pages, 0);
    END IF;
    v_new_best := greatest(v_best, v_total);
    v_pages := v_pages + (v_new_best - v_best);
    v_books := v_books || jsonb_build_object(v_item.book_id, jsonb_build_object('t', v_total, 'b', v_new_best, 'd', v_owed));
    IF v_item.kind = 0 THEN
      v_count := v_count + 1;
      IF v_first IS NULL AND least(floor(v_pages / 2), 10) > 0 THEN
        v_first := coalesce(v_item.logged_at, now());
      END IF;
    END IF;
  END LOOP;

  v_used := least(floor(v_pages / 2), 10)::int;

  SELECT pe.data->>'timestamp',
         CASE WHEN jsonb_typeof(pe.data->'amount') = 'number' THEN (pe.data->>'amount')::numeric END,
         pe.data
  INTO v_kept, v_kept_amt, v_kept_row
  FROM public.point_entries pe
  WHERE pe.user_id = p_user AND pe.id = v_id AND pe.deleted_at IS NULL;

  IF p_floor AND v_used <= coalesce(v_kept_amt, 0) THEN
    RETURN; -- an earlier day never drops
  END IF;

  IF v_used > 0 THEN
    v_at := least(greatest(v_first, v_day_start), now(), v_day_end - interval '1 millisecond');
    INSERT INTO public.point_entries AS pe (user_id, id, data, created_at, updated_at)
    VALUES (p_user, v_id, jsonb_build_object(
      'id', v_id,
      'amount', v_used,
      'reason', 'Pages logged (' || v_count || ')',
      'source', 'reading',
      'timestamp', coalesce(v_kept, to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      'metadata', jsonb_build_object('date', v_key, 'logs', v_count)
    ) || jsonb_strip_nulls(jsonb_build_object('gainedAt', public.ascend_award_gained_at(v_kept_row, v_used))), now(), now())
    ON CONFLICT (user_id, id) DO UPDATE
      SET data = EXCLUDED.data, deleted_at = NULL, updated_at = greatest(now(), pe.updated_at)
      WHERE pe.data IS DISTINCT FROM EXCLUDED.data OR pe.deleted_at IS NOT NULL;
  ELSE
    UPDATE public.point_entries pe
    SET deleted_at = now(), updated_at = greatest(now(), pe.updated_at)
    WHERE pe.user_id = p_user AND pe.id = v_id AND pe.deleted_at IS NULL;
  END IF;

  IF p_floor THEN
    RETURN; -- never takes anything away from an earlier day
  END IF;

  UPDATE public.point_entries pe
  SET deleted_at = now(), updated_at = greatest(now(), pe.updated_at)
  WHERE pe.user_id = p_user
    AND pe.deleted_at IS NULL
    AND pe.id NOT LIKE 'reading\_award\_%'
    AND pe.id NOT LIKE 'reading\_bonus\_%'
    AND pe.data->>'source' IN ('reading', 'reading_bonus')
    AND jsonb_typeof(pe.data->'amount') = 'number'
    AND (pe.data->>'amount')::numeric > 0
    AND public.ascend_instant(pe.data->>'timestamp') >= v_day_start
    AND public.ascend_instant(pe.data->>'timestamp') < v_day_end;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.ascend_recompute_focus_awards_day(p_user uuid, p_day date, p_tz text, p_floor boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_key       text        := to_char(p_day, 'YYYY-MM-DD');
  v_day_start timestamptz := p_day::timestamp AT TIME ZONE p_tz;
  v_day_end   timestamptz := (p_day + 1)::timestamp AT TIME ZONE p_tz;
  v_cap       integer     := 10; -- PFC_POINTS.focus.dailyCap
  v_per_point integer     := 12; -- PFC_POINTS.focus.minutesPerPoint
  v_fixed     integer     := 0;
  v_minutes   integer     := 0;
  v_used      integer     := 0;
  v_count     int         := 0;
  v_first     timestamptz;
  v_kept      text;
  v_kept_row  jsonb;
  v_kept_amt  integer;
  v_at        timestamptz;
  v_id        text        := 'focus_award_' || to_char(p_day, 'YYYY-MM-DD');
  v_part      record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('focus_awards:' || p_user::text || ':' || v_key));

  -- Sessions of the day: rows dated that day, and R1 / rule-2 rows of the next day with a part on it.
  SELECT count(*) INTO v_count
  FROM public.focus_logs f
  WHERE f.user_id = p_user
    AND f.deleted_at IS NULL
    AND (f.log_date = p_day
         OR ((f.planned_minutes IS NOT NULL OR f.points_rule = 2) AND f.log_date = p_day + 1
             AND EXISTS (SELECT 1 FROM public.ascend_focus_log_parts(p_tz, f) p WHERE p.part_day = p_day)));

  -- Old-rule rows only ever have parts on their own date (or the day before for R1), so one
  -- window covers every kind.
  FOR v_part IN
    SELECT p.part_points AS points, p.part_minutes AS minutes, p.part_at AS at
    FROM public.focus_logs f
    CROSS JOIN LATERAL public.ascend_focus_log_parts(p_tz, f) p
    WHERE f.user_id = p_user
      AND f.deleted_at IS NULL
      AND f.log_date BETWEEN p_day AND p_day + 1
      AND p.part_day = p_day
    ORDER BY p.part_at, f.id COLLATE "C", p.part_ord
  LOOP
    v_fixed := v_fixed + v_part.points;
    v_minutes := v_minutes + v_part.minutes;
    v_used := least(v_cap, v_fixed + v_minutes / v_per_point);
    IF v_first IS NULL AND v_used > 0 THEN
      v_first := coalesce(v_part.at, now());
    END IF;
  END LOOP;

  SELECT pe.data->>'timestamp', CASE WHEN (pe.data->>'amount') ~ '^-?[0-9]+$' THEN (pe.data->>'amount')::integer END,
         pe.data
  INTO v_kept, v_kept_amt, v_kept_row
  FROM public.point_entries pe
  WHERE pe.user_id = p_user AND pe.id = v_id AND pe.deleted_at IS NULL;

  IF p_floor AND v_used <= coalesce(v_kept_amt, 0) THEN
    RETURN; -- an earlier day never drops
  END IF;

  IF v_used > 0 THEN
    v_at := least(greatest(v_first, v_day_start), now(), v_day_end - interval '1 millisecond');
    INSERT INTO public.point_entries AS pe (user_id, id, data, created_at, updated_at)
    VALUES (p_user, v_id, jsonb_build_object(
      'id', v_id,
      'amount', v_used,
      'reason', 'Focus sessions (' || v_count || ')',
      'source', 'focus',
      'timestamp', coalesce(v_kept, to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      'metadata', jsonb_build_object('date', v_key, 'sessions', v_count)
    ) || jsonb_strip_nulls(jsonb_build_object('gainedAt', public.ascend_award_gained_at(v_kept_row, v_used))), now(), now())
    ON CONFLICT (user_id, id) DO UPDATE
      SET data = EXCLUDED.data, deleted_at = NULL, updated_at = greatest(now(), pe.updated_at)
      WHERE pe.data IS DISTINCT FROM EXCLUDED.data OR pe.deleted_at IS NOT NULL;
  ELSE
    UPDATE public.point_entries pe
    SET deleted_at = now(), updated_at = greatest(now(), pe.updated_at)
    WHERE pe.user_id = p_user AND pe.id = v_id AND pe.deleted_at IS NULL;
  END IF;

  UPDATE public.point_entries pe
  SET deleted_at = now(), updated_at = greatest(now(), pe.updated_at)
  WHERE pe.user_id = p_user
    AND pe.deleted_at IS NULL
    AND pe.id NOT LIKE 'focus\_award\_%'
    AND pe.data->>'source' = 'focus'
    AND public.ascend_instant(pe.data->>'timestamp') >= v_day_start
    AND public.ascend_instant(pe.data->>'timestamp') < v_day_end;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.ascend_recompute_time_tracker_award(p_user uuid, p_day date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_key       text := to_char(p_day, 'YYYY-MM-DD');
  v_id        text := 'time_tracker_' || to_char(p_day, 'YYYY-MM-DD');
  v_blocks    jsonb;
  v_total     integer := 0;
  v_skipped   integer := 0;
  v_completed integer := 0;
  v_excluded  integer := 0;
  v_denom     integer;
  v_points    integer := 0;
  v_percent   integer := 0;
  v_metadata  jsonb;
  v_current   jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('time_tracker_awards:' || p_user::text || ':' || v_key));

  SELECT d.data->'blocks' INTO v_blocks
  FROM public.time_tracker_days d
  WHERE d.user_id = p_user AND d.id = v_key AND d.deleted_at IS NULL;

  IF jsonb_typeof(v_blocks) = 'array' THEN
    SELECT count(*),
           count(*) FILTER (WHERE b->'skipped' = 'true'::jsonb),
           count(*) FILTER (WHERE b->'completed' = 'true'::jsonb)
    INTO v_total, v_skipped, v_completed
    FROM jsonb_array_elements(v_blocks) AS b;
  END IF;

  IF v_total > 0 THEN
    IF v_total > 3 THEN
      v_excluded := least(v_skipped, least((3 * v_total) / 10, 3));
    END IF;
    v_denom := v_total - v_excluded;
    IF v_denom > 0 THEN
      v_points := CASE WHEN v_completed * 100 >= 80 * v_denom THEN 5
                       WHEN v_completed * 100 >= 50 * v_denom THEN 3
                       ELSE 0 END;
      v_percent := (200 * v_completed + v_denom) / (2 * v_denom);
    END IF;
  END IF;

  IF v_points > 0 THEN
    v_metadata := jsonb_build_object('date', v_key, 'percentage', v_percent, 'pointsAwarded', v_points);
    SELECT pe.data INTO v_current
    FROM public.point_entries pe
    WHERE pe.user_id = p_user AND pe.id = v_id AND pe.deleted_at IS NULL;
    IF v_current IS NOT NULL
       AND v_current->'amount' = to_jsonb(v_points)
       AND v_current->'metadata' = v_metadata THEN
      RETURN;
    END IF;
    INSERT INTO public.point_entries AS pe (user_id, id, data, created_at, updated_at)
    VALUES (p_user, v_id, jsonb_build_object(
      'id', v_id,
      'amount', v_points,
      'reason', 'Time Tracker daily routine completed (' || v_percent || '%): ' || v_points || ' pts',
      'source', 'time_tracker',
      'timestamp', coalesce(v_current->>'timestamp', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      'metadata', v_metadata
    ) || jsonb_strip_nulls(jsonb_build_object('gainedAt', public.ascend_award_gained_at(v_current, v_points))), now(), now())
    ON CONFLICT (user_id, id) DO UPDATE
      SET data = EXCLUDED.data, deleted_at = NULL, updated_at = greatest(now(), pe.updated_at);
  ELSE
    UPDATE public.point_entries pe
    SET deleted_at = now(), updated_at = greatest(now(), pe.updated_at)
    WHERE pe.user_id = p_user AND pe.id = v_id AND pe.deleted_at IS NULL;
  END IF;
END;
$function$
;

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
           coalesce(sum(-e.amount) FILTER (WHERE e.src IN ('habit_missed', 'bad_habit_no_report')), 0) AS penalty_points,
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
           coalesce(sum(-e.amount) FILTER (WHERE e.src IN ('habit_missed', 'bad_habit_no_report')), 0) AS penalty_points,
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

COMMIT;
