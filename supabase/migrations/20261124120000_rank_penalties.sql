-- Penalties by rank (2026-11-24, release 1.8.0, v2). Plan: knowledge/mode-a-rank-penalties-2026-11-24.md.
-- A missed library habit, a bad-habit slip and an unlogged bad-habit day now cost by the season rank:
--   Beginner (< 200 season points)            a flat 1 point (any base > 0; never grows for misses in a row)
--   Starter, Learner, Trainer (200 - 1399)     half of the full penalty, rounded UP (never 0, never more)
--   Achiever and up (>= 1400)                  unchanged: round(base x ascend_miss_multiplier)
-- The rank lines are the tiers.ts minimums (Starter 200, Achiever 1400); every season, plain tier rule.
-- Client mirror: src/lib/points/missPenalty.ts (getMissPenalty, getEffectiveMissMultiplier);
-- change both sides together.
--
-- New (pure, IMMUTABLE, search_path '', not SECURITY DEFINER; EXECUTE for service_role only, like
-- ascend_miss_multiplier):
--   ascend_miss_effective_multiplier(base, misses, season)  the multiplier a row stores (metadata
--       'multiplier' and the reason's "(Nx penalty)"): Beginner round(1 / base, 2), the share of the
--       base the flat point is (1, 0.5, 0.33; never above 1 for a base >= 1, so the app's points
--       list adds no "x" label); Starter to Trainer 0.5 x ascend_miss_multiplier (0.5, 0.75);
--       Achiever+ ascend_miss_multiplier. Before rounding, base x it = the penalty (Beginner: to 2 decimals).
--   ascend_miss_penalty(base, misses, season) -> int     the points one miss costs
-- Changed (CREATE OR REPLACE of the LIVE bodies read with pg_get_functiondef on 2026-11-24, only the
-- penalty lines changed; no signature change, so owner, ACL, SECURITY DEFINER and search_path stay):
--   ascend_process_penalties            missed library habit + bad-habit no-report candidates
--   ascend_recompute_bad_habit_awards   slips
-- ascend_miss_multiplier is unchanged and still used (by the new functions).
--
-- Beginner behaviour: a missed habit writes a -1 entry and the notice "... 1 points deducted." (the
-- same text every 1-point penalty has had since 2026-10-15); a no-report is a 1-point candidate
-- (row, log -1, notice) inside the day's 4-penalty limit; a slip gets a -1 row. The bad-day walk
-- counts those days, so the multiplier continues correctly after 200. The season score never goes
-- below 0 (ascend_season_points), so a Beginner at 0 still gets the -1 row but stays at 0.
-- Past rows are never touched (no backfill or refund).
--
-- Order: BEFORE the studio test of 1.8.0. Prod-compatible: the old prod client only shows server
-- rows; until prod gets 1.8.0 its "next miss" hints and its own short-lived slip preview show the
-- old full amount, and the server's row replaces that preview (same id).
-- Rollback: re-run the live copies of the two functions saved before apply, then DROP the two new
-- functions.

BEGIN;

CREATE OR REPLACE FUNCTION public.ascend_miss_effective_multiplier(p_base numeric, p_misses integer, p_season_points integer)
 RETURNS double precision
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT (CASE
    -- Beginner (tiers.ts Starter minPoints): the flat point as a share of the base, 2 decimals.
    WHEN coalesce(p_season_points, 0) < 200 THEN
      CASE WHEN coalesce(p_base, 0) > 0 THEN round(1 / p_base, 2) ELSE 0 END
    -- Starter to Trainer (Achiever minPoints): half.
    WHEN coalesce(p_season_points, 0) < 1400 THEN
      0.5 * public.ascend_miss_multiplier(p_misses, coalesce(p_season_points, 0))::numeric
    ELSE public.ascend_miss_multiplier(p_misses, coalesce(p_season_points, 0))::numeric
  END)::double precision;
$function$;

CREATE OR REPLACE FUNCTION public.ascend_miss_penalty(p_base numeric, p_misses integer, p_season_points integer)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN coalesce(p_base, 0) <= 0 THEN 0
    -- Beginner: a flat 1 point, whatever the base or the misses in a row.
    WHEN coalesce(p_season_points, 0) < 200 THEN 1
    -- Starter to Trainer: half of the full penalty, rounded up.
    WHEN coalesce(p_season_points, 0) < 1400 THEN
      ceil(p_base * public.ascend_miss_multiplier(p_misses, coalesce(p_season_points, 0))::numeric * 0.5)::int
    ELSE round(p_base * public.ascend_miss_multiplier(p_misses, coalesce(p_season_points, 0))::numeric)::int
  END;
$function$;

REVOKE ALL ON FUNCTION public.ascend_miss_effective_multiplier(numeric, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ascend_miss_penalty(numeric, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ascend_miss_effective_multiplier(numeric, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ascend_miss_penalty(numeric, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.ascend_process_penalties(p_user uuid, p_tz text, p_from date, p_to date, p_apply boolean)
 RETURNS TABLE(kind text, entity_id text, period text, amount integer, multiplier double precision)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_now_iso    text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_season     int  := public.ascend_season_points(p_user);
  v_username   text;
  v_partner    uuid;
  v_day        date;
  v_habit      record;
  v_bad        record;
  v_key        text;
  v_created    date;
  v_created_key text;
  v_cursor     text;
  v_cursor_day date;
  v_misses     int;
  v_mult       double precision;
  v_penalty    int;
  v_entry_id   text;
  v_done       boolean;
  v_slots      int;
  v_goal       jsonb;
  v_target     int;
  v_logged     int;
  v_avg        int;
  v_inserted   int;
  v_changed    boolean := false;
BEGIN
  SELECT pr.username INTO v_username FROM public.profiles pr WHERE pr.id = p_user;

  v_day := p_from;
  WHILE v_day <= p_to LOOP

    -- a) Preset habits
    FOR v_habit IN
      SELECT h.id, h.data
      FROM public.habits h
      WHERE h.user_id = p_user AND h.deleted_at IS NULL
        AND coalesce(h.data->>'isPreset', '') = 'true'
        AND coalesce((h.data->>'points')::numeric, 0) > 0
      ORDER BY h.created_at, h.id
    LOOP
      v_created := public.ascend_local_date(v_habit.data->>'createdAt', p_tz);
      IF v_created IS NULL OR v_day < v_created THEN
        CONTINUE;
      END IF;

      -- A missing frequency is daily, as in the app (habitPenalties.ts).
      IF coalesce(v_habit.data->>'frequency', 'daily') = 'daily' THEN
        v_key := to_char(v_day, 'YYYY-MM-DD');
        v_created_key := coalesce(v_habit.data->>'createdAtPeriod', to_char(v_created, 'YYYY-MM-DD'));
      ELSE
        IF extract(isodow FROM v_day) <> 7 THEN
          CONTINUE;
        END IF;
        v_key := public.ascend_week_key(v_day, p_tz);
        v_created_key := coalesce(v_habit.data->>'createdAtPeriod', public.ascend_week_key(v_created, p_tz));
      END IF;

      v_done := CASE jsonb_typeof(v_habit.data->'completions')
        WHEN 'object' THEN coalesce(v_habit.data->'completions'->v_key->>'done', '') = 'true'
        WHEN 'array'  THEN (v_habit.data->'completions') ? v_key
        ELSE false END;
      IF v_done THEN
        CONTINUE;
      END IF;

      IF EXISTS (
        SELECT 1 FROM public.point_entries pe
        WHERE pe.user_id = p_user
          AND (pe.id = 'habit_missed_' || v_habit.id || '_' || v_key
               OR (pe.data->>'source' = 'habit_missed'
                   AND pe.data->'metadata'->>'habitId' = v_habit.id
                   AND pe.data->'metadata'->>'period' = v_key))
      ) THEN
        CONTINUE;
      END IF;

      v_misses := 0;
      v_cursor := v_key;
      FOR i IN 1..(CASE WHEN coalesce(v_habit.data->>'frequency', 'daily') = 'daily' THEN 90 ELSE 52 END) LOOP
        EXIT WHEN v_cursor < v_created_key;
        EXIT WHEN CASE jsonb_typeof(v_habit.data->'completions')
          WHEN 'object' THEN coalesce(v_habit.data->'completions'->v_cursor->>'done', '') = 'true'
          WHEN 'array'  THEN (v_habit.data->'completions') ? v_cursor
          ELSE false END;
        v_misses := v_misses + 1;
        IF coalesce(v_habit.data->>'frequency', 'daily') = 'daily' THEN
          v_cursor := to_char(v_cursor::date - 1, 'YYYY-MM-DD');
        ELSE
          v_cursor := public.ascend_add_weeks(v_cursor, -1, p_tz);
        END IF;
      END LOOP;

      -- Rank band (2026-11-24): Beginner a flat 1, Starter to Trainer half rounded up, Achiever+ as before.
      v_mult := public.ascend_miss_effective_multiplier((v_habit.data->>'points')::numeric, v_misses, v_season);
      v_penalty := public.ascend_miss_penalty((v_habit.data->>'points')::numeric, v_misses, v_season);
      v_entry_id := 'habit_missed_' || v_habit.id || '_' || v_key;

      IF p_apply THEN
        INSERT INTO public.point_entries (user_id, id, data, created_at, updated_at)
        VALUES (p_user, v_entry_id, jsonb_build_object(
          'id', v_entry_id,
          'amount', -v_penalty,
          'reason', 'Missed habit (' || v_mult || 'x penalty): ' || (v_habit.data->>'name'),
          'source', 'habit_missed',
          'timestamp', v_now_iso,
          'metadata', jsonb_build_object('habitId', v_habit.id, 'habitName', v_habit.data->>'name', 'period', v_key, 'multiplier', v_mult)
        ), now(), now())
        ON CONFLICT (user_id, id) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted = 0 THEN
          CONTINUE;
        END IF;

        PERFORM public.create_notification_atomic(
          p_recipient_id => p_user,
          p_type => 'missed_habit',
          p_title => 'Habit Missed Penalty',
          p_message => 'You missed your habit "' || (v_habit.data->>'name') || '" for period ' || v_key || '. '
                       || CASE WHEN v_penalty > 0 THEN v_penalty || ' points deducted.' ELSE '' END,
          p_payload => jsonb_build_object('habitId', v_habit.id, 'habitName', v_habit.data->>'name', 'period', v_key,
                                          'dedupKey', 'missed_habit_' || v_habit.id || '_' || v_key)
        );
        FOR v_partner IN
          SELECT CASE WHEN ps.user1_id = p_user THEN ps.user2_id ELSE ps.user1_id END
          FROM public.partnerships ps
          WHERE ps.user1_id = p_user OR ps.user2_id = p_user
          ORDER BY ps.paired_at, ps.id
        LOOP
          PERFORM public.create_notification_atomic(
            p_recipient_id => v_partner,
            p_actor_id => p_user,
            p_type => 'partner_missed_habit',
            p_title => 'Streak Risk Warning',
            p_message => 'Your partner ' || coalesce(v_username, 'User') || ' missed their habit "' || (v_habit.data->>'name')
                         || '". Reach out to encourage them!',
            p_payload => jsonb_build_object('habitId', v_habit.id, 'habitName', v_habit.data->>'name', 'period', v_key,
                                            'dedupKey', 'partner_missed_habit_' || p_user || '_' || v_habit.id || '_' || v_key)
          );
        END LOOP;
        v_changed := true;
      END IF;

      v_season := greatest(v_season - v_penalty, 0);
      kind := 'habit_missed'; entity_id := v_habit.id; period := v_key; amount := -v_penalty; multiplier := v_mult;
      RETURN NEXT;
    END LOOP;

    -- b) Bad-habit no-reports: every active bad habit; ascend_miss_penalty of its points, the same
    --    as a slip. At most 4 bad habits lose points a day, slips and no-reports together
    --    (BAD_HABIT_POINTS.dailyPenaltyLimit): the day's live slip penalties and the new no-report
    --    candidates are ranked by amount (ties: slip first, then time, then id) and the top ones
    --    are charged; a no-report outside them gets a 0-point log, a slip outside them loses its
    --    penalty. A no-report already charged on the day keeps its slot. Settled once: the run that
    --    writes the day's no-report logs; later runs find no candidates and change nothing.
    v_key := to_char(v_day, 'YYYY-MM-DD');
    SELECT 4 - count(*) INTO v_slots -- dailyPenaltyLimit
    FROM public.point_entries pe
    WHERE pe.user_id = p_user AND pe.deleted_at IS NULL
      AND pe.id LIKE 'bad\_habit\_no\_report\_%' AND pe.data->'metadata'->>'date' = v_key;

    FOR v_bad IN
      WITH habit AS (
        SELECT bh.id, bh.data,
          public.ascend_local_date(bh.data->>'createdAt', p_tz) AS created,
          public.ascend_instant(bh.data->>'createdAt') AS at
        FROM public.bad_habits bh
        WHERE bh.user_id = p_user AND bh.deleted_at IS NULL
          AND coalesce(bh.data->>'isCompleted', '') <> 'true'
      ), missed AS (
        SELECT h.*,
          -- Bad days in a row before this one (slipped or not logged), the same walk as the app.
          1 + public.ascend_bad_habit_bad_days_before(p_user, h.id, v_day, h.created) AS occ
        FROM habit h
        WHERE h.created IS NOT NULL AND v_day >= h.created
          AND NOT EXISTS (
            SELECT 1 FROM public.bad_habit_logs l
            WHERE l.user_id = p_user
              AND ((l.deleted_at IS NULL AND l.data->>'badHabitId' = h.id AND l.data->>'date' = v_key)
                   OR l.id = 'no_report_' || h.id || '_' || v_key))
      ), candidate AS (
        SELECT 'no_report'::text AS what, 1 AS what_order, m.id AS bh_id, m.data, m.at, m.id AS tie_id, m.occ,
          public.ascend_miss_effective_multiplier(public.ascend_bad_habit_points(m.data), m.occ, v_season) AS mult,
          -- Rank band: a Beginner no-report costs a flat 1.
          public.ascend_miss_penalty(public.ascend_bad_habit_points(m.data), m.occ, v_season) AS penalty,
          NULL::text AS entry_id
        FROM missed m
        UNION ALL
        SELECT 'slip', 0, pe.data->'metadata'->>'badHabitId', NULL::jsonb, public.ascend_instant(pe.data->>'timestamp'),
          pe.id, NULL::int, NULL::double precision,
          greatest(round(-coalesce((pe.data->>'amount')::numeric, 0))::int, 0), pe.id
        FROM public.point_entries pe
        WHERE pe.user_id = p_user AND pe.deleted_at IS NULL
          AND pe.id LIKE 'bad\_habit\_occurred\_%' AND pe.data->'metadata'->>'date' = v_key
          AND EXISTS (SELECT 1 FROM missed)
      )
      SELECT c.*, row_number() OVER (ORDER BY c.penalty DESC, c.what_order, c.at NULLS LAST, c.tie_id COLLATE "C") AS rank
      FROM candidate c
      WHERE c.penalty > 0
      ORDER BY rank
    LOOP
      IF v_bad.what = 'slip' THEN
        CONTINUE WHEN v_bad.rank <= v_slots;
        -- Outside the day's top: this slip costs nothing after all.
        IF p_apply THEN
          UPDATE public.point_entries pe
          SET deleted_at = now(), updated_at = greatest(now(), pe.updated_at)
          WHERE pe.user_id = p_user AND pe.id = v_bad.entry_id AND pe.deleted_at IS NULL;
          v_changed := true;
        END IF;
        v_season := v_season + v_bad.penalty;
        kind := 'bad_habit_occurred_refunded'; entity_id := v_bad.bh_id; period := v_key; amount := v_bad.penalty; multiplier := NULL;
        RETURN NEXT;
        CONTINUE;
      END IF;

      IF v_bad.rank <= v_slots THEN
        v_mult := v_bad.mult;
        v_penalty := v_bad.penalty;
      ELSE
        v_mult := 1;
        v_penalty := 0;
      END IF;

      IF p_apply THEN
        INSERT INTO public.bad_habit_logs (user_id, id, data, created_at, updated_at)
        VALUES (p_user, 'no_report_' || v_bad.bh_id || '_' || v_key, jsonb_build_object(
          'id', 'no_report_' || v_bad.bh_id || '_' || v_key,
          'badHabitId', v_bad.bh_id,
          'date', v_key,
          'status', 'no_report',
          'consecutiveOccurrences', v_bad.occ,
          'pointsAwardedOrDeducted', -v_penalty,
          'createdAt', v_now_iso
        ), now(), now())
        ON CONFLICT (user_id, id) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted = 0 THEN
          CONTINUE;
        END IF;
        v_changed := true;

        IF v_penalty > 0 THEN
          v_entry_id := 'bad_habit_no_report_' || v_bad.bh_id || '_' || v_key;
          INSERT INTO public.point_entries (user_id, id, data, created_at, updated_at)
          VALUES (p_user, v_entry_id, jsonb_build_object(
            'id', v_entry_id,
            'amount', -v_penalty,
            'reason', 'No-report bad habit penalty (' || v_mult || 'x penalty): ' || (v_bad.data->>'name'),
            'source', 'bad_habit_no_report',
            'timestamp', v_now_iso,
            'metadata', jsonb_build_object('badHabitId', v_bad.bh_id, 'badHabitName', v_bad.data->>'name', 'date', v_key, 'multiplier', v_mult)
          ), now(), now())
          ON CONFLICT (user_id, id) DO NOTHING;

          PERFORM public.create_notification_atomic(
            p_recipient_id => p_user,
            p_type => 'bad_habit_no_report',
            p_title => 'Bad Habit No-Report Penalty',
            p_message => 'No status reported for "' || (v_bad.data->>'name') || '" on ' || v_key || '. '
                         || v_penalty || ' points deducted.',
            p_payload => jsonb_build_object('badHabitId', v_bad.bh_id, 'badHabitName', v_bad.data->>'name', 'date', v_key,
                                            'dedupKey', 'bad_habit_' || v_bad.bh_id || '_' || v_key)
          );
        END IF;
      END IF;

      v_season := greatest(v_season - v_penalty, 0);
      kind := 'bad_habit_no_report'; entity_id := v_bad.bh_id; period := v_key; amount := -v_penalty; multiplier := v_mult;
      RETURN NEXT;
    END LOOP;

    -- c) Weekly exercise target removed 2026-10-17; earlier exercise_missed rows stay.

    v_day := v_day + 1;
  END LOOP;

  IF p_apply AND v_changed THEN
    v_season := public.ascend_season_points(p_user);
    UPDATE public.profiles SET season_points = v_season, total_points = v_season WHERE id = p_user;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ascend_recompute_bad_habit_awards(p_user uuid, p_day date, p_tz text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_key       text        := to_char(p_day, 'YYYY-MM-DD');
  v_day_start timestamptz := p_day::timestamp AT TIME ZONE p_tz;
  v_used      int         := 0;
  v_alloc     int;
  v_kept      text[]      := '{}';
  v_id        text;
  v_at        timestamptz;
  v_occ       int;
  v_season    int;
  v_charged   int         := 0;
  v_base      jsonb       := '{}'::jsonb;
  v_extra     int;
  v_item      record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('bad_habit_awards:' || p_user::text || ':' || v_key));

  -- a) Resists: one log per habit (the earliest), every active bad habit, its own points in log
  --    order up to the cap; a resist that already earned goes first and keeps at least that much.
  --    Two passes (CR-10-2): first every resist gets back what it earned, then the rest of the cap
  --    goes in the same order, so a resist that earned first can't push out a later one's points.
  FOR v_item IN
    SELECT * FROM (
      SELECT DISTINCT ON (l.data->>'badHabitId')
        l.data->>'badHabitId' AS bh_id,
        coalesce(public.ascend_instant(l.data->>'createdAt'), 'epoch'::timestamptz) AS logged_at,
        l.id,
        coalesce((
          SELECT greatest(round(coalesce((pe.data->>'amount')::numeric, 0))::int, 0)
          FROM public.point_entries pe
          WHERE pe.user_id = p_user AND pe.deleted_at IS NULL
            AND pe.id = 'bad_habit_resist_' || (l.data->>'badHabitId') || '_' || v_key
        ), 0) AS earned
      FROM public.bad_habit_logs l
      JOIN public.bad_habits bh
        ON bh.user_id = l.user_id AND bh.id = l.data->>'badHabitId' AND bh.deleted_at IS NULL
      WHERE l.user_id = p_user AND l.deleted_at IS NULL
        AND l.data->>'date' = v_key AND l.data->>'status' = 'resisted'
      ORDER BY l.data->>'badHabitId', 2, l.id COLLATE "C"
    ) r
    ORDER BY (r.earned > 0) DESC, r.logged_at, r.id COLLATE "C"
  LOOP
    v_alloc := least(v_item.earned, greatest(6 - v_used, 0)); -- dailyCap
    v_used := v_used + v_alloc;
    v_base := v_base || jsonb_build_object(v_item.bh_id, v_alloc);
  END LOOP;

  FOR v_item IN
    SELECT * FROM (
      SELECT DISTINCT ON (l.data->>'badHabitId')
        l.data->>'badHabitId' AS bh_id,
        bh.data->>'name' AS name,
        public.ascend_bad_habit_points(bh.data) AS points,
        coalesce(public.ascend_instant(l.data->>'createdAt'), 'epoch'::timestamptz) AS logged_at,
        l.id,
        coalesce((
          SELECT greatest(round(coalesce((pe.data->>'amount')::numeric, 0))::int, 0)
          FROM public.point_entries pe
          WHERE pe.user_id = p_user AND pe.deleted_at IS NULL
            AND pe.id = 'bad_habit_resist_' || (l.data->>'badHabitId') || '_' || v_key
        ), 0) AS earned
      FROM public.bad_habit_logs l
      JOIN public.bad_habits bh
        ON bh.user_id = l.user_id AND bh.id = l.data->>'badHabitId' AND bh.deleted_at IS NULL
      WHERE l.user_id = p_user AND l.deleted_at IS NULL
        AND l.data->>'date' = v_key AND l.data->>'status' = 'resisted'
      ORDER BY l.data->>'badHabitId', 4, l.id COLLATE "C"
    ) r
    ORDER BY (r.earned > 0) DESC, r.logged_at, r.id COLLATE "C"
  LOOP
    v_alloc := coalesce((v_base->>v_item.bh_id)::int, 0);
    v_extra := least(greatest(greatest(v_item.earned, v_item.points) - v_alloc, 0), greatest(6 - v_used, 0)); -- dailyCap
    v_used := v_used + v_extra;
    v_alloc := v_alloc + v_extra;
    CONTINUE WHEN v_alloc <= 0;

    v_id := 'bad_habit_resist_' || v_item.bh_id || '_' || v_key;
    v_kept := array_append(v_kept, v_id);
    v_at := least(greatest(v_item.logged_at, v_day_start), now());

    INSERT INTO public.point_entries AS pe (user_id, id, data, created_at, updated_at)
    VALUES (p_user, v_id, jsonb_build_object(
      'id', v_id,
      'amount', v_alloc,
      'reason', 'Bad habit resisted: ' || coalesce(v_item.name, ''),
      'source', 'bad_habit_resisted',
      'timestamp', to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'metadata', jsonb_build_object('badHabitId', v_item.bh_id, 'date', v_key, 'status', 'resisted')
    ), now(), now())
    ON CONFLICT (user_id, id) DO UPDATE
      SET data = EXCLUDED.data, deleted_at = NULL, updated_at = greatest(now(), pe.updated_at)
      WHERE pe.data IS DISTINCT FROM EXCLUDED.data OR pe.deleted_at IS NOT NULL;
  END LOOP;

  -- b) Occurred: every active bad habit; a new penalty is ascend_miss_penalty of its points, a
  --    live one keeps its amount. At most 4 slips are charged a day (BAD_HABIT_POINTS.dailyPenaltyLimit):
  --    the largest penalties, ties by the earlier log, then log id. A slip outside the 4 gets no row
  --    (its live row, if any, is removed in c) and gets one again if a larger slip is undone. Only the
  --    user's local today is ever recomputed, so earlier days stay frozen.
  IF EXISTS (SELECT 1 FROM public.bad_habit_logs l
             WHERE l.user_id = p_user AND l.deleted_at IS NULL
               AND l.data->>'date' = v_key AND l.data->>'status' = 'occurred') THEN
    -- The season total for the multiplier counts only rows that still hold (CR-09-23): a resist
    -- row whose log is now a slip (or gone), and a slip row whose log is no longer a slip, are
    -- removed first (step c would remove them anyway).
    UPDATE public.point_entries pe
    SET deleted_at = now(), updated_at = greatest(now(), pe.updated_at)
    WHERE pe.user_id = p_user
      AND pe.deleted_at IS NULL
      AND pe.data->'metadata'->>'date' = v_key
      AND ((pe.id LIKE 'bad\_habit\_resist\_%' AND NOT pe.id = ANY (v_kept))
           OR (pe.id LIKE 'bad\_habit\_occurred\_%' AND NOT EXISTS (
                 SELECT 1 FROM public.bad_habit_logs l
                 JOIN public.bad_habits bh
                   ON bh.user_id = l.user_id AND bh.id = l.data->>'badHabitId' AND bh.deleted_at IS NULL
                 WHERE l.user_id = p_user AND l.deleted_at IS NULL
                   AND l.data->>'date' = v_key AND l.data->>'status' = 'occurred'
                   AND pe.id = 'bad_habit_occurred_' || (l.data->>'badHabitId') || '_' || v_key)));
    v_season := public.ascend_season_points(p_user);

    FOR v_item IN
      WITH slip AS (
        SELECT DISTINCT ON (l.data->>'badHabitId')
          l.data->>'badHabitId' AS bh_id,
          bh.data->>'name' AS name,
          bh.data AS bh_data,
          bh.data->>'createdAt' AS habit_created,
          coalesce(public.ascend_instant(l.data->>'createdAt'), 'epoch'::timestamptz) AS logged_at,
          l.id AS log_id
        FROM public.bad_habit_logs l
        JOIN public.bad_habits bh
          ON bh.user_id = l.user_id AND bh.id = l.data->>'badHabitId' AND bh.deleted_at IS NULL
        WHERE l.user_id = p_user AND l.deleted_at IS NULL
          AND l.data->>'date' = v_key AND l.data->>'status' = 'occurred'
        ORDER BY l.data->>'badHabitId', 5, l.id COLLATE "C"
      ), counted AS (
        SELECT s.*,
          (SELECT greatest(round(-coalesce((pe.data->>'amount')::numeric, 0))::int, 0)
           FROM public.point_entries pe
           WHERE pe.user_id = p_user AND pe.deleted_at IS NULL
             AND pe.id = 'bad_habit_occurred_' || s.bh_id || '_' || v_key) AS kept_penalty,
          -- consecutiveOccurrences: 1 + the bad days in a row before the day (slipped or not logged).
          1 + public.ascend_bad_habit_bad_days_before(
            p_user, s.bh_id, p_day, public.ascend_local_date(s.habit_created, p_tz)) AS occ
        FROM slip s
      ), priced AS (
        SELECT c.*, public.ascend_miss_effective_multiplier(public.ascend_bad_habit_points(c.bh_data), c.occ, v_season) AS mult
        FROM counted c
      )
      -- Rank band (2026-11-24): a Beginner slip costs a flat 1; Starter to Trainer half, rounded up;
      -- Achiever+ as before (ascend_miss_penalty).
      SELECT p.bh_id, p.name, p.logged_at, p.mult, p.kept_penalty IS NOT NULL AS kept,
        coalesce(p.kept_penalty,
                 public.ascend_miss_penalty(public.ascend_bad_habit_points(p.bh_data), p.occ, v_season)) AS penalty
      FROM priced p
      ORDER BY 6 DESC, p.logged_at, p.log_id COLLATE "C"
    LOOP
      CONTINUE WHEN v_item.penalty <= 0;
      v_charged := v_charged + 1;
      CONTINUE WHEN v_charged > 4; -- dailyPenaltyLimit

      v_id := 'bad_habit_occurred_' || v_item.bh_id || '_' || v_key;
      v_kept := array_append(v_kept, v_id);
      CONTINUE WHEN v_item.kept;

      v_at := least(greatest(v_item.logged_at, v_day_start), now());
      INSERT INTO public.point_entries AS pe (user_id, id, data, created_at, updated_at)
      VALUES (p_user, v_id, jsonb_build_object(
        'id', v_id,
        'amount', -v_item.penalty,
        'reason', 'Bad habit occurred (' || v_item.mult || 'x penalty): ' || coalesce(v_item.name, ''),
        'source', 'bad_habit_occurred',
        'timestamp', to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'metadata', jsonb_build_object('badHabitId', v_item.bh_id, 'date', v_key, 'status', 'occurred')
      ), now(), now())
      ON CONFLICT (user_id, id) DO UPDATE
        SET data = EXCLUDED.data, deleted_at = NULL, updated_at = greatest(now(), pe.updated_at);
    END LOOP;
  END IF;

  -- c) Rows that no longer hold, and the app-written resist/occurred rows of the day.
  UPDATE public.point_entries pe
  SET deleted_at = now(), updated_at = greatest(now(), pe.updated_at)
  WHERE pe.user_id = p_user
    AND pe.deleted_at IS NULL
    AND pe.data->'metadata'->>'date' = v_key
    AND (
      ((pe.id LIKE 'bad\_habit\_resist\_%' OR pe.id LIKE 'bad\_habit\_occurred\_%') AND NOT pe.id = ANY (v_kept))
      OR (pe.id NOT LIKE 'bad\_habit\_%'
          AND pe.data->>'source' IN ('bad_habit_resisted', 'bad_habit_occurred', 'bad_habit_undo'))
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.ascend_process_penalties(uuid, text, date, date, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ascend_process_penalties(uuid, text, date, date, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.ascend_recompute_bad_habit_awards(uuid, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ascend_recompute_bad_habit_awards(uuid, date, text) TO service_role;

COMMIT;
