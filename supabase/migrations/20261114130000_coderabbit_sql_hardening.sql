-- CodeRabbit Phase 5: SQL hardening (2026-11-14).
--
-- Every function below is CREATE OR REPLACE of the LIVE body (pg_get_functiondef, read 2026-11-14)
-- with only the change named in its section. No signature changes (no old overloads to drop), no
-- new functions, no table or column changes, no grants changed (CREATE OR REPLACE keeps each
-- function's owner, ACL, SECURITY DEFINER and pinned search_path exactly as they are live).
--
-- Apply: any time (prod-compatible; the app needs nothing new). Best BEFORE Zakria's studio test
-- of the matching app mirrors (weeklyGoalPoints/weeklyAwards, badHabitAwards/stateAwards,
-- focusAwards), so preview and server agree.
--
-- Items:
--   CR-09-9   guard_day_future                      absent old completions -> future check-in passed
--   CR-09-13  profiles_guard_timezone               invalid kept device_timezone failed profile saves
--   CR-09-14  ascend_apply_waiting_timezones        AT TIME ZONE could run before the validity check
--   CR-09-20  ascend_process_penalties              partner miss notice key lacked the habit owner
--   CR-09-21  ascend_cleanup_abandoned_guests       guest active after the scan could still be deleted
--   CR-09-26  ascend_rank_celebrated_valid          {} validated to NULL, so the marker was erased
--   CR-09-27  ascend_keep_rank_celebrated           int/bigint cast overflow on a huge marker
--   CR-10-6   user_plan_follows_guard               sourceUsername settable via array->object steps
--   CR-09-24  ascend_recompute_weekly_goal_awards   season-split week ignored the frozen row's goals
--             (client mirror CR-05-17: src/lib/points/weeklyGoalPoints.ts + weeklyAwards.ts)
--   CR-10-2   ascend_recompute_bad_habit_awards     resist allocation could move earned points
--   CR-09-23  ascend_recompute_bad_habit_awards     stale resist row raised the slip multiplier tier
--             (client mirror: src/lib/points/badHabitAwards.ts + stateAwards.ts)
--   CR-10-13  ascend_recompute_focus_awards_day     award stamped at next midnight (no day-end clamp)
--             (client mirror: src/lib/points/focusAwards.ts)
--   CR-09-19  shared_challenges_guard               joint_streak taken from the app, now computed
--   CR-10-15  ascend_member_card                    array-form completions ignored in 3 summaries
--
-- Not changed here (see knowledge/mode-a-cr-p5-sql-2026-11-14.md):
--   CR-09-10  award vs penalty default for a missing habit frequency: frequency is required in the
--             app type and 0 live rows lack it; changing it would change the award rule in SQL and
--             3 client places for a case that cannot happen. Reported, not changed.
--   CR-09-15  season tie-breaker: live ascend_season_points / ascend_season_history already order
--             by (awarded_at, id), the same as ascend_period_points. Already fixed live.
--   CR-10-1   two files share version 20261019170000 (reading_bonus_cooldown, reading_book_unit_lock).
--             Not renamed: the live DB has no supabase_migrations.schema_migrations table (files are
--             applied by hand), so the duplicate affects only a fresh `supabase db reset/push`; the two
--             files touch different functions and run in name order (bonus_cooldown first).
--
-- Rollback: re-run the live definitions saved in work/cr-p5-sql/live/<function>_<oid>.sql.

-- ============================================================================
-- CR-09-9: guard_day_future: a habit row with no old completions field can no longer get a future check-in.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.guard_day_future()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_device text;
  v_today  date;
  v_latest text;
  v_key    text;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT tz.name INTO v_device
  FROM public.profiles pr
  JOIN public.ascend_timezones tz ON tz.name = pr.device_timezone
  WHERE pr.id = NEW.user_id;
  v_today := greatest((now() AT TIME ZONE public.ascend_user_timezone(NEW.user_id))::date,
                      (now() AT TIME ZONE v_device)::date);
  v_latest := to_char(v_today, 'YYYY-MM-DD');

  IF TG_TABLE_NAME = 'focus_logs' THEN
    IF TG_OP = 'UPDATE' THEN
      IF NEW.log_date IS NOT DISTINCT FROM OLD.log_date THEN
        RETURN NEW;
      END IF;
    END IF;
    IF NEW.log_date > v_today THEN
      RAISE EXCEPTION 'focus_logs row % is dated in the future (%)', NEW.id, NEW.log_date
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'journal_entries' THEN
    IF TG_OP = 'UPDATE' THEN
      IF NEW.entry_date IS NOT DISTINCT FROM OLD.entry_date THEN
        RETURN NEW;
      END IF;
    END IF;
    IF NEW.entry_date > v_today THEN
      RAISE EXCEPTION 'journal_entries row % is dated in the future (%)', NEW.id, NEW.entry_date
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'habits' THEN
    IF jsonb_typeof(NEW.data->'completions') = 'object' THEN
      FOR v_key IN SELECT jsonb_object_keys(NEW.data->'completions') LOOP
        IF v_key ~ '^\d{4}-\d{2}-\d{2}$' AND v_key > v_latest
          AND NOT coalesce(TG_OP = 'UPDATE' AND jsonb_typeof(OLD.data->'completions') = 'object' AND (OLD.data->'completions') ? v_key, false)
        THEN
          RAISE EXCEPTION 'habit % completion % is in the future', NEW.id, v_key
            USING ERRCODE = 'check_violation';
        END IF;
      END LOOP;
    ELSIF jsonb_typeof(NEW.data->'completions') = 'array' THEN
      FOR v_key IN SELECT jsonb_array_elements_text(NEW.data->'completions') LOOP
        IF v_key ~ '^\d{4}-\d{2}-\d{2}$' AND v_key > v_latest
          AND NOT coalesce(TG_OP = 'UPDATE' AND jsonb_typeof(OLD.data->'completions') = 'array' AND (OLD.data->'completions') ? v_key, false)
        THEN
          RAISE EXCEPTION 'habit % completion % is in the future', NEW.id, v_key
            USING ERRCODE = 'check_violation';
        END IF;
      END LOOP;
    END IF;
    RETURN NEW;
  END IF;

  v_key := NEW.data->>'date';
  IF v_key ~ '^\d{4}-\d{2}-\d{2}' AND left(v_key, 10) > v_latest THEN
    RAISE EXCEPTION '% row % is dated in the future (%)', TG_TABLE_NAME, NEW.id, v_key
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

-- ============================================================================
-- CR-09-13: profiles_guard_timezone: a stored device_timezone that is not a valid name is dropped (NULL) instead of kept, and the date comparison runs only on valid names, so it can no longer fail an unrelated profile save.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.profiles_guard_timezone()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- A changed device_timezone that is not a valid name falls back to the OLD value.
  IF TG_OP = 'INSERT' THEN
    IF NOT public.ascend_is_timezone(NEW.device_timezone) THEN
      NEW.device_timezone := NULL;
    END IF;
  ELSIF NEW.device_timezone IS DISTINCT FROM OLD.device_timezone THEN
    IF NOT public.ascend_is_timezone(NEW.device_timezone) THEN
      NEW.device_timezone := OLD.device_timezone;
    END IF;
  END IF;
  -- A kept value that is not a valid name either (an old row) is dropped, so the conversion
  -- below can never fail an unrelated profile save (CR-09-13).
  IF NEW.device_timezone IS NOT NULL AND NOT public.ascend_is_timezone(NEW.device_timezone) THEN
    NEW.device_timezone := NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.timezone := coalesce(NEW.device_timezone, 'Asia/Karachi');
    NEW.timezone_waiting_since := NULL;
    RETURN NEW;
  END IF;

  NEW.timezone := OLD.timezone;
  NEW.timezone_waiting_since := OLD.timezone_waiting_since;

  IF NEW.device_timezone IS NULL OR NEW.device_timezone = NEW.timezone THEN
    NEW.timezone_waiting_since := NULL;
  ELSIF (CASE WHEN public.ascend_is_timezone(NEW.timezone)
              THEN (now() AT TIME ZONE NEW.device_timezone)::date >= (now() AT TIME ZONE NEW.timezone)::date
              ELSE true END)
  THEN
    NEW.timezone := NEW.device_timezone;
    NEW.timezone_waiting_since := NULL;
  ELSIF NEW.device_timezone IS DISTINCT FROM OLD.device_timezone OR NEW.timezone_waiting_since IS NULL THEN
    NEW.timezone_waiting_since := now();
  END IF;
  RETURN NEW;
END;
$function$;

-- ============================================================================
-- CR-09-14: ascend_apply_waiting_timezones (hourly cron): the time-zone conversion runs inside a CASE only for valid names, so the planner can no longer run it on an invalid name first and abort the whole hourly run.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ascend_apply_waiting_timezones()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  UPDATE public.profiles p
  SET timezone = CASE WHEN public.ascend_is_timezone(p.device_timezone) THEN p.device_timezone ELSE 'Asia/Karachi' END,
      timezone_waiting_since = NULL
  WHERE NOT public.ascend_is_timezone(p.timezone);

  UPDATE public.profiles p
  SET timezone = p.device_timezone,
      timezone_waiting_since = NULL
  WHERE p.device_timezone IS DISTINCT FROM p.timezone
    -- CASE, not AND: WHERE clauses may run in any order, and AT TIME ZONE raises on a bad name.
    AND CASE WHEN public.ascend_is_timezone(p.device_timezone) AND public.ascend_is_timezone(p.timezone)
             THEN (now() AT TIME ZONE p.device_timezone)::date >= (now() AT TIME ZONE p.timezone)::date
                  OR p.timezone_waiting_since < now() - interval '48 hours'
             ELSE false END;
END;
$function$;

-- ============================================================================
-- CR-09-20: ascend_process_penalties: the partner's missed-habit notice key carries the habit owner's id, so two partners' misses of habits with the same id are no longer merged into one notice.
-- ============================================================================
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

      v_mult := public.ascend_miss_multiplier(v_misses, v_season);
      v_penalty := round((v_habit.data->>'points')::numeric * v_mult::numeric)::int;
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

    -- b) Bad-habit no-reports: every active bad habit; its points x the miss multiplier, the same
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
          public.ascend_miss_multiplier(m.occ, v_season) AS mult,
          round(public.ascend_bad_habit_points(m.data)
                * public.ascend_miss_multiplier(m.occ, v_season)::numeric)::int AS penalty,
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

-- ============================================================================
-- CR-09-21: ascend_cleanup_abandoned_guests (daily cron): before deleting, the candidates' user_data rows are locked and their activity is checked again, so a guest who became active after the candidate scan is not deleted.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ascend_cleanup_abandoned_guests(p_days integer DEFAULT 30, p_limit integer DEFAULT 100, p_dry_run boolean DEFAULT false, p_only uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_now timestamptz := now();
  v_cutoff timestamptz;
  v_candidates integer := 0;
  v_ids uuid[] := '{}';
  v_skipped uuid[] := '{}';
  v_deleted integer := 0;
  v_note text;
BEGIN
  IF p_days IS NULL OR p_days < 0 THEN
    RAISE EXCEPTION 'p_days must be >= 0';
  END IF;
  IF p_days < 7 AND p_only IS NULL THEN
    RAISE EXCEPTION 'p_days must be >= 7 unless p_only is set';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'p_limit must be >= 1';
  END IF;

  v_cutoff := v_now - make_interval(days => p_days);

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.ascend_guest_cleanup_candidates (
    id uuid PRIMARY KEY,
    last_active timestamptz,
    protected boolean
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.ascend_guest_cleanup_candidates;

  INSERT INTO pg_temp.ascend_guest_cleanup_candidates (id, last_active, protected)
  SELECT c.id, c.last_active,
         EXISTS (
           SELECT 1
           FROM public.improvement_plans ip
           WHERE ip.creator_id = c.id
             AND EXISTS (SELECT 1 FROM public.user_plan_follows f
                         WHERE f.original_plan_id = ip.id AND f.user_id <> c.id)
         )
  FROM (
    SELECT u.id,
           greatest(
             u.created_at,
             u.last_sign_in_at,
             u.updated_at,
             s.last_session,
             CASE WHEN ud.updated_at > v_now THEN v_now ELSE ud.updated_at END
           ) AS last_active
    FROM auth.users u
    LEFT JOIN LATERAL (
      SELECT max(greatest(ss.refreshed_at AT TIME ZONE 'UTC', ss.updated_at, ss.created_at)) AS last_session
      FROM auth.sessions ss
      WHERE ss.user_id = u.id
    ) s ON true
    LEFT JOIN public.user_data ud ON ud.user_id = u.id
    WHERE u.is_anonymous = true
      AND coalesce(u.email, '') = ''
      AND coalesce(u.phone, '') = ''
      AND u.is_sso_user = false
      AND u.deleted_at IS NULL
      AND (p_only IS NULL OR u.id = p_only)
    FOR UPDATE OF u SKIP LOCKED
  ) c
  WHERE c.last_active IS NULL OR c.last_active < v_cutoff;

  SELECT count(*)::integer,
         coalesce(array_agg(id ORDER BY last_active NULLS FIRST, id) FILTER (WHERE protected), '{}')
  INTO v_candidates, v_skipped
  FROM pg_temp.ascend_guest_cleanup_candidates;

  SELECT coalesce(array_agg(t.id ORDER BY t.last_active NULLS FIRST, t.id), '{}')
  INTO v_ids
  FROM (
    SELECT id, last_active
    FROM pg_temp.ascend_guest_cleanup_candidates
    WHERE NOT protected
    ORDER BY last_active NULLS FIRST, id
    LIMIT p_limit
  ) t;

  IF p_dry_run THEN
    v_deleted := coalesce(array_length(v_ids, 1), 0);
  ELSE
    -- The candidate scan locked only auth.users: lock the guests' user_data rows too (a save
    -- waits until this run ends), then check the activity again (CR-09-21).
    PERFORM 1 FROM public.user_data ud WHERE ud.user_id = ANY (v_ids) FOR UPDATE;
    DELETE FROM auth.users u
    WHERE u.id = ANY (v_ids)
      AND u.is_anonymous = true
      AND NOT EXISTS (SELECT 1 FROM public.user_data ud
                      WHERE ud.user_id = u.id AND least(ud.updated_at, v_now) >= v_cutoff)
      AND NOT EXISTS (SELECT 1 FROM auth.sessions ss
                      WHERE ss.user_id = u.id
                        AND greatest(ss.refreshed_at AT TIME ZONE 'UTC', ss.updated_at, ss.created_at) >= v_cutoff);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END IF;

  IF v_candidates - coalesce(array_length(v_skipped, 1), 0) > p_limit THEN
    v_note := 'more pending';
  END IF;
  IF coalesce(array_length(v_skipped, 1), 0) > 0 THEN
    v_note := concat_ws('; ', v_note, 'skipped guests own plans followed or noted by other users');
  END IF;

  -- Counts only: a deleted guest leaves no id or name behind (Security B1). user_ids and
  -- usernames keep their '{}' defaults; skipped_user_ids are guests who still exist.
  INSERT INTO public.ascend_guest_cleanup_log
    (dry_run, p_days, p_limit, p_only, candidates, deleted, skipped, skipped_user_ids, note)
  VALUES
    (p_dry_run, p_days, p_limit, p_only, v_candidates, v_deleted,
     coalesce(array_length(v_skipped, 1), 0), v_skipped, v_note);

  DROP TABLE pg_temp.ascend_guest_cleanup_candidates;

  RETURN v_deleted;
END;
$function$;

-- ============================================================================
-- CR-09-26: ascend_rank_celebrated_valid: an incomplete marker such as {} is "not valid" (false), not NULL, so the trigger restores the stored marker instead of letting {} erase it.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ascend_rank_celebrated_valid(memory jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT coalesce(memory IS NOT NULL
     AND jsonb_typeof(memory) = 'object'
     AND jsonb_typeof(memory -> 'season') = 'number'
     AND jsonb_typeof(memory -> 'tierIndex') = 'number'
     AND (memory ->> 'season') ~ '^[0-9]+$'
     AND (memory ->> 'tierIndex') ~ '^[0-9]+$', false);
$function$;

-- ============================================================================
-- CR-09-27: ascend_keep_rank_celebrated: season and tier are compared as numeric, so a huge stored number can no longer overflow int/bigint and fail every later save of user_data.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ascend_keep_rank_celebrated()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  old_memory jsonb := OLD.state -> 'rankCelebrated';
  new_memory jsonb := NEW.state -> 'rankCelebrated';
BEGIN
  IF NEW.state IS NULL OR jsonb_typeof(NEW.state) <> 'object' THEN
    RETURN NEW;
  END IF;
  IF NOT ascend_rank_celebrated_valid(old_memory) THEN
    RETURN NEW;
  END IF;

  IF NOT ascend_rank_celebrated_valid(new_memory)
     OR (old_memory ->> 'season')::numeric > (new_memory ->> 'season')::numeric
     OR ((old_memory ->> 'season')::numeric = (new_memory ->> 'season')::numeric
         AND (old_memory ->> 'tierIndex')::numeric > (new_memory ->> 'tierIndex')::numeric) THEN
    NEW.state := jsonb_set(NEW.state, '{rankCelebrated}', old_memory, true);
  END IF;

  RETURN NEW;
END;
$function$;

-- ============================================================================
-- CR-10-6: user_plan_follows_guard: on every update that stores an object, sourceUsername comes from the stored row (or null when the stored steps are not an object), so a client can't set it through an array-to-object change.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.user_plan_follows_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_creator text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM public.user_plan_follows f WHERE f.id = NEW.id) THEN
      RETURN NEW;
    END IF;
    IF NEW.original_plan_id IS NOT NULL THEN
      SELECT p.creator_username INTO v_creator
      FROM public.improvement_plans p
      WHERE p.id = NEW.original_plan_id AND p.is_public AND p.creator_id <> v_uid;
      IF NOT FOUND THEN
        NEW.original_plan_id := NULL;
      END IF;
    END IF;
    IF jsonb_typeof(NEW.steps) = 'object' THEN
      NEW.steps := jsonb_set(NEW.steps, '{sourceUsername}', coalesce(to_jsonb(v_creator), 'null'::jsonb));
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.original_plan_id IS NOT NULL AND NEW.original_plan_id IS DISTINCT FROM OLD.original_plan_id THEN
    NEW.original_plan_id := OLD.original_plan_id;
  END IF;
  IF jsonb_typeof(NEW.steps) = 'object' THEN
    NEW.steps := jsonb_set(NEW.steps, '{sourceUsername}', coalesce(
      CASE WHEN jsonb_typeof(OLD.steps) = 'object' THEN OLD.steps -> 'sourceUsername' END, 'null'::jsonb));
  END IF;
  RETURN NEW;
END;
$function$;

-- ============================================================================
-- CR-09-24: ascend_recompute_weekly_goal_awards: in the week a season starts in, the goals the earlier season's frozen row counted stay counted in this season's part (their points are already subtracted), so unticking or deleting one of them after the boundary no longer takes points from goals done later.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ascend_recompute_weekly_goal_awards(p_user uuid, p_week text, p_tz text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_start       date := public.ascend_week_start(p_week);
  v_start_at    timestamptz;
  v_end_at      timestamptz;
  v_boundary    timestamptz;
  v_floor       timestamptz;
  v_today_start timestamptz := ((now() AT TIME ZONE p_tz)::date)::timestamp AT TIME ZONE p_tz;
  v_season      int;
  v_split       boolean := false;
  v_goals       jsonb;
  v_times       timestamptz[];
  v_counted_js  jsonb;
  v_completed   int := 0;
  v_counted     int := 0;
  v_points      int;
  v_earlier     int;
  v_legacy_hold int := 0;
  v_base_id     text := 'weekly_goal_' || p_week;
  v_id          text;
  v_existing    jsonb;
  v_base        jsonb;
  v_ts          text;
  v_reason      text;
  v_metadata    jsonb;
BEGIN
  IF v_start IS NULL OR v_start < DATE '2026-10-01' THEN
    RETURN; -- POINTS_V2_START_DATE_KEY: older weeks keep what they have
  END IF;
  v_start_at := v_start::timestamp AT TIME ZONE p_tz;
  v_end_at := (v_start + 7)::timestamp AT TIME ZONE p_tz - interval '1 millisecond';
  IF v_end_at < public.ascend_season_start(now()) THEN
    RETURN; -- a closed season's week is frozen
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('weekly_goal_awards:' || p_user::text || ':' || p_week));

  -- The week a season started in, once that season runs: the earlier part stays frozen.
  v_boundary := public.ascend_season_start(v_end_at);
  IF v_boundary > v_start_at AND now() >= v_boundary THEN
    v_split := true;
    v_season := public.ascend_lesson_season(v_boundary);
    v_id := v_base_id || '_s' || v_season;
  ELSE
    v_id := v_base_id;
  END IF;

  SELECT pe.data INTO v_existing
  FROM public.point_entries pe
  WHERE pe.user_id = p_user AND pe.id = v_id AND pe.deleted_at IS NULL;
  IF v_split THEN
    -- The earlier season's row (frozen): its counted goals stay counted here too (CR-09-24).
    SELECT pe.data INTO v_base
    FROM public.point_entries pe
    WHERE pe.user_id = p_user AND pe.id = v_base_id AND pe.deleted_at IS NULL;
  END IF;

  SELECT CASE WHEN wg.deleted_at IS NULL THEN coalesce(wg.data->'goals', '[]'::jsonb) ELSE '[]'::jsonb END
  INTO v_goals
  FROM public.weekly_goals wg
  WHERE wg.user_id = p_user AND wg.id = p_week;
  IF v_goals IS NULL OR jsonb_typeof(v_goals) <> 'array' THEN
    v_goals := '[]'::jsonb;
  END IF;

  -- Achieved goals in completion order (ties keep list order), plus every goal this row counted
  -- on an earlier day (metadata.counted, achieved before today): those stay counted even when
  -- unticked, deleted or no longer linked; in a split week also every goal the earlier season's
  -- frozen row counted (its amount is subtracted below). The first 3 count.
  WITH achieved AS (
    SELECT coalesce(g.value->>'id', '#' || g.ord) AS id,
           public.ascend_goal_completion_time(g.value) AS at,
           g.ord AS ord
    FROM jsonb_array_elements(v_goals) WITH ORDINALITY AS g(value, ord)
    WHERE jsonb_typeof(g.value) = 'object'
      AND (g.value->'completed' = 'true'::jsonb OR g.value->'done' = 'true'::jsonb)
      AND NOT (g.value ? 'archived' AND g.value->'archived' NOT IN ('false'::jsonb, 'null'::jsonb, '0'::jsonb, '""'::jsonb))
  ), held_refs AS (
    SELECT c.value->>'id' AS id, public.ascend_instant(c.value->>'at') AS at
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(v_existing->'metadata'->'counted') = 'array'
           THEN v_existing->'metadata'->'counted' ELSE '[]'::jsonb END) AS c(value)
    WHERE jsonb_typeof(c.value) = 'object'
      AND coalesce(c.value->>'id', '') <> ''
      AND public.ascend_instant(c.value->>'at') < v_today_start
    UNION ALL
    SELECT c.value->>'id', public.ascend_instant(c.value->>'at')
    FROM jsonb_array_elements(
      CASE WHEN v_split AND jsonb_typeof(v_base->'metadata'->'counted') = 'array'
           THEN v_base->'metadata'->'counted' ELSE '[]'::jsonb END) AS c(value)
    WHERE jsonb_typeof(c.value) = 'object'
      AND coalesce(c.value->>'id', '') <> ''
      AND public.ascend_instant(c.value->>'at') IS NOT NULL
  ), held AS (
    SELECT r.id, min(r.at) AS at FROM held_refs r GROUP BY r.id
  ), scoring AS (
    SELECT coalesce(a.id, h.id) AS id,
           CASE WHEN h.at IS NOT NULL AND (a.at IS NULL OR h.at < a.at) THEN h.at ELSE a.at END AS at,
           coalesce(a.ord, 1000000) AS ord
    FROM achieved a FULL JOIN held h ON h.id = a.id
  ), ordered AS (
    SELECT s.id, s.at, row_number() OVER (ORDER BY s.at NULLS FIRST, s.ord, s.id COLLATE "C") AS rn
    FROM scoring s
  )
  SELECT array_agg(o.at ORDER BY o.rn),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id,
           'at', to_char(o.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY o.rn)
           FILTER (WHERE o.rn <= 3), '[]'::jsonb),
         count(*)::int
  INTO v_times, v_counted_js, v_completed
  FROM ordered o;
  v_times := coalesce(v_times, '{}'::timestamptz[]);
  v_counted := least(v_completed, 3); -- WEEKLY_GOALS_POINTS.maxGoalsCounted
  v_points := v_counted * 5;          -- WEEKLY_GOALS_POINTS.pointsPerGoal

  -- A row written before metadata.counted existed: what it held before today stays (all of it
  -- when it was stamped before today, else all but the goal stamped today).
  IF v_existing IS NOT NULL AND jsonb_typeof(v_existing->'metadata'->'counted') IS DISTINCT FROM 'array'
     AND jsonb_typeof(v_existing->'amount') = 'number' THEN
    v_legacy_hold := CASE
      WHEN coalesce(public.ascend_instant(v_existing->>'timestamp') < v_today_start, false)
        THEN (v_existing->>'amount')::int
      ELSE greatest((v_existing->>'amount')::int - 5, 0) END;
  END IF;

  IF v_split THEN
    SELECT coalesce((pe.data->>'amount')::int, 0) INTO v_earlier
    FROM public.point_entries pe
    WHERE pe.user_id = p_user AND pe.id = v_base_id AND pe.deleted_at IS NULL;
    IF v_earlier IS NULL THEN
      SELECT count(*)::int * 5 INTO v_earlier
      FROM unnest(v_times[1:3]) AS c(at)
      WHERE c.at < v_boundary;
    END IF;
    v_points := greatest(0, v_points - v_earlier);
    v_floor := v_boundary;
    v_metadata := jsonb_build_object('weekKey', p_week, 'seasonNumber', v_season,
                                     'countedGoalsCount', v_counted, 'completedGoalsCount', v_completed,
                                     'counted', v_counted_js);
  ELSE
    v_floor := v_start_at;
    v_metadata := jsonb_build_object('weekKey', p_week,
                                     'countedGoalsCount', v_counted, 'completedGoalsCount', v_completed,
                                     'counted', v_counted_js);
    -- Any other app-written goal row of the week (the app merged these into the canonical one).
    UPDATE public.point_entries pe
    SET deleted_at = now(), updated_at = greatest(now(), pe.updated_at)
    WHERE pe.user_id = p_user
      AND pe.deleted_at IS NULL
      AND pe.data->>'source' = 'weekly_goal_achieved'
      AND pe.data->'metadata'->>'weekKey' = p_week
      AND pe.id <> v_base_id
      AND pe.id !~ '^weekly_goal_\d{4}-W\d{2}_s\d+$';
  END IF;

  IF v_legacy_hold > v_points THEN
    -- The old row holds more, earned before today: it keeps that part (and nothing else changes).
    IF v_legacy_hold < (v_existing->>'amount')::int THEN
      UPDATE public.point_entries pe
      SET data = jsonb_set(pe.data, '{amount}', to_jsonb(v_legacy_hold)),
          updated_at = greatest(now(), pe.updated_at)
      WHERE pe.user_id = p_user AND pe.id = v_id AND pe.deleted_at IS NULL;
    END IF;
    RETURN;
  END IF;

  IF v_split THEN
    v_reason := 'Weekly goals achieved for ' || p_week || ', Season ' || v_season || ' (' || v_points || ' pts)';
  ELSE
    v_reason := 'Weekly goals achieved for ' || p_week || ' (' || v_points || ' pts)';
  END IF;

  IF v_points > 0 THEN
    -- Stamped when earned: the last counted goal's completion, between v_floor and now
    -- (weeklyGoalAwardTimestamp in weeklyAwards.ts).
    v_ts := to_char(greatest(least(coalesce(v_times[v_counted], now()), now()), v_floor) AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    INSERT INTO public.point_entries AS pe (user_id, id, data, created_at, updated_at)
    VALUES (p_user, v_id, jsonb_build_object(
      'id', v_id,
      'amount', v_points,
      'reason', v_reason,
      'source', 'weekly_goal_achieved',
      'timestamp', v_ts,
      'metadata', v_metadata
    ), now(), now())
    ON CONFLICT (user_id, id) DO UPDATE
      SET data = EXCLUDED.data, deleted_at = NULL, updated_at = greatest(now(), pe.updated_at)
      WHERE pe.data IS DISTINCT FROM EXCLUDED.data OR pe.deleted_at IS NOT NULL;
  ELSIF v_existing IS NOT NULL THEN
    UPDATE public.point_entries pe
    SET deleted_at = now(), updated_at = greatest(now(), pe.updated_at)
    WHERE pe.user_id = p_user AND pe.id = v_id AND pe.deleted_at IS NULL;
  END IF;
END;
$function$;

-- ============================================================================
-- CR-10-2 + CR-09-23: ascend_recompute_bad_habit_awards: (CR-10-2) resists are allocated in two passes so one resist can't take another's already-earned points; (CR-09-23) the season total used for the slip multiplier no longer counts today's rows that no longer hold (a resist turned into a slip).
-- ============================================================================
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

  -- b) Occurred: every active bad habit; a new penalty is its points x the miss multiplier, a
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
      ), priced AS (
        SELECT s.*,
          (SELECT greatest(round(-coalesce((pe.data->>'amount')::numeric, 0))::int, 0)
           FROM public.point_entries pe
           WHERE pe.user_id = p_user AND pe.deleted_at IS NULL
             AND pe.id = 'bad_habit_occurred_' || s.bh_id || '_' || v_key) AS kept_penalty,
          -- consecutiveOccurrences: 1 + the bad days in a row before the day (slipped or not logged).
          public.ascend_miss_multiplier(
            1 + public.ascend_bad_habit_bad_days_before(
              p_user, s.bh_id, p_day, public.ascend_local_date(s.habit_created, p_tz)),
            v_season) AS mult
        FROM slip s
      )
      SELECT p.bh_id, p.name, p.logged_at, p.mult, p.kept_penalty IS NOT NULL AS kept,
        coalesce(p.kept_penalty,
                 round(public.ascend_bad_habit_points(p.bh_data) * p.mult::numeric)::int) AS penalty
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

-- ============================================================================
-- CR-10-13: ascend_recompute_focus_awards_day: the day's award is stamped no later than the day's last millisecond (like reading and skills), so a session part ending exactly at midnight can't land in the next day or week.
-- ============================================================================
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

  SELECT pe.data->>'timestamp', CASE WHEN (pe.data->>'amount') ~ '^-?[0-9]+$' THEN (pe.data->>'amount')::integer END
  INTO v_kept, v_kept_amt
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
    ), now(), now())
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
$function$;

-- ============================================================================
-- CR-09-19: shared_challenges_guard: joint_streak is computed by the server from the joint days (the run ending today or yesterday in the caller's zone, as calculateJointStreak), not taken from the app; the column stays (old apps still send it).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.shared_challenges_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_is_user1 boolean;
  v_today    text;
  v_tz       text;
  v_own      text[];
  v_new_own  text[];
  v_u1       text[];
  v_u2       text[];
  v_total    integer;
  v_duration integer;
  v_user1    uuid;
  v_user2    uuid;
  v_tz1      text;
  v_tz2      text;
  v_own_day  integer;
  v_joint    text[];
  v_day      date;
  v_streak   integer := 0;
BEGIN
  -- A caller-less insert (service role) without a start date gets the same rule as the app's
  -- inserts below: the later of the two partners' local dates at creation.
  IF TG_OP = 'INSERT' AND v_uid IS NULL AND NEW.start_date IS NULL THEN
    SELECT greatest(
             (coalesce(NEW.created_at, now()) AT TIME ZONE public.ascend_user_timezone(p.user1_id))::date,
             (coalesce(NEW.created_at, now()) AT TIME ZONE public.ascend_user_timezone(p.user2_id))::date)
    INTO NEW.start_date
    FROM public.partnerships p
    WHERE p.id = NEW.partnership_id;
  END IF;

  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM public.shared_challenges sc WHERE sc.id = NEW.id) THEN
      RETURN NEW;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.partnerships p
      WHERE p.id = NEW.partnership_id AND (p.user1_id = v_uid OR p.user2_id = v_uid)
    ) THEN
      RAISE EXCEPTION 'Unauthorized: You are not a member of this partnership.';
    END IF;
    NEW.created_at := now();
    -- The shared start date (any value the client sent is replaced): the later of the two
    -- partners' local dates now, the first date both can still tick.
    SELECT greatest((NEW.created_at AT TIME ZONE public.ascend_user_timezone(p.user1_id))::date,
                    (NEW.created_at AT TIME ZONE public.ascend_user_timezone(p.user2_id))::date)
    INTO NEW.start_date
    FROM public.partnerships p
    WHERE p.id = NEW.partnership_id;
    NEW.user1_done_dates := '[]'::jsonb;
    NEW.user2_done_dates := '[]'::jsonb;
    NEW.user1_done_date := NULL;
    NEW.user2_done_date := NULL;
    NEW.joint_streak := 0;
    NEW.total_joint_days_completed := 0;
    NEW.status := 'active';
    RETURN NEW;
  END IF;

  SELECT (p.user1_id = v_uid), p.user1_id, p.user2_id INTO v_is_user1, v_user1, v_user2
  FROM public.partnerships p
  WHERE p.id = OLD.partnership_id AND (p.user1_id = v_uid OR p.user2_id = v_uid);
  IF v_is_user1 IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: You are not a member of this partnership.';
  END IF;

  NEW.id := OLD.id;
  NEW.partnership_id := OLD.partnership_id;
  NEW.created_at := OLD.created_at;
  NEW.start_date := OLD.start_date;
  NEW.title := OLD.title;
  NEW.target_habit_name := OLD.target_habit_name;
  NEW.duration_days := OLD.duration_days;
  NEW.user1_category := OLD.user1_category;
  NEW.user1_target := OLD.user1_target;
  NEW.user2_category := OLD.user2_category;
  NEW.user2_target := OLD.user2_target;

  -- A finished pact (completed or ended) is frozen: no tick, no untick, no status change, so the
  -- notify trigger sends nothing either. The hourly pact expiry runs without a caller (above).
  IF OLD.status IN ('completed', 'expired', 'broken') THEN
    NEW := OLD;
    RETURN NEW;
  END IF;

  v_tz := coalesce(public.ascend_own_timezone(v_uid), 'Asia/Karachi');
  v_today := to_char((now() AT TIME ZONE v_tz)::date, 'YYYY-MM-DD');

  IF v_is_user1 THEN
    v_own := public.ascend_pact_dates(OLD.user1_done_dates, OLD.user1_done_date);
    v_new_own := public.ascend_pact_dates(NEW.user1_done_dates, NULL);
  ELSE
    v_own := public.ascend_pact_dates(OLD.user2_done_dates, OLD.user2_done_date);
    v_new_own := public.ascend_pact_dates(NEW.user2_done_dates, NULL);
  END IF;
  -- The caller's own today changes only while today is one of the pact's days for the caller
  -- (day 1 = start_date, the same calendar date for both; a row without one counts from the
  -- creation day in the caller's zone). Before day 1 (the partner behind in time on the creation
  -- evening) and after the last day their side stays as it is.
  v_own_day := (now() AT TIME ZONE v_tz)::date
               - coalesce(OLD.start_date, (OLD.created_at AT TIME ZONE v_tz)::date) + 1;
  IF v_own_day BETWEEN 1 AND coalesce(OLD.duration_days, 7) THEN
    v_own := array_remove(v_own, v_today);
    IF v_today = ANY (v_new_own) THEN
      v_own := v_own || v_today;
    END IF;
  END IF;
  SELECT coalesce(array_agg(d ORDER BY d), '{}'::text[]) INTO v_own FROM unnest(v_own) AS u(d);

  IF v_is_user1 THEN
    NEW.user1_done_dates := to_jsonb(v_own);
    NEW.user1_done_date := v_own[array_upper(v_own, 1)]::date;
    NEW.user2_done_dates := OLD.user2_done_dates;
    NEW.user2_done_date := OLD.user2_done_date;
  ELSE
    NEW.user2_done_dates := to_jsonb(v_own);
    NEW.user2_done_date := v_own[array_upper(v_own, 1)]::date;
    NEW.user1_done_dates := OLD.user1_done_dates;
    NEW.user1_done_date := OLD.user1_done_date;
  END IF;

  v_u1 := public.ascend_pact_dates(NEW.user1_done_dates, NEW.user1_done_date);
  v_u2 := public.ascend_pact_dates(NEW.user2_done_dates, NEW.user2_done_date);
  SELECT coalesce(array_agg(j.d), '{}'::text[]), count(*) INTO v_joint, v_total
  FROM (SELECT unnest(v_u1) INTERSECT SELECT unnest(v_u2)) j(d);
  v_duration := coalesce(NEW.duration_days, 7);
  v_tz1 := public.ascend_user_timezone(v_user1);
  v_tz2 := public.ascend_user_timezone(v_user2);

  NEW.total_joint_days_completed := v_total;
  NEW.status := CASE
    WHEN v_total >= v_duration THEN 'completed'
    WHEN (now() AT TIME ZONE v_tz1)::date - coalesce(NEW.start_date, (NEW.created_at AT TIME ZONE v_tz1)::date) + 1 > v_duration
     AND (now() AT TIME ZONE v_tz2)::date - coalesce(NEW.start_date, (NEW.created_at AT TIME ZONE v_tz2)::date) + 1 > v_duration THEN 'expired'
    ELSE 'active'
  END;
  -- Joint streak (CR-09-19): consecutive joint days ending today, or yesterday when today is not
  -- joint yet, in the caller's zone (calculateJointStreak in pactLifecycle.ts). The app's value is ignored.
  v_day := (now() AT TIME ZONE v_tz)::date;
  IF NOT (to_char(v_day, 'YYYY-MM-DD') = ANY (v_joint)) THEN
    v_day := v_day - 1;
  END IF;
  WHILE to_char(v_day, 'YYYY-MM-DD') = ANY (v_joint) LOOP
    v_streak := v_streak + 1;
    v_day := v_day - 1;
  END LOOP;
  NEW.joint_streak := v_streak;
  RETURN NEW;
END;
$function$;

-- ============================================================================
-- CR-10-15: ascend_member_card: active days, today's habit count and habit adherence read array-form (legacy) completions too, like the streak block and ascend_process_penalties already do.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ascend_member_card(p_member uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_viewer_public boolean;
  v_allowed boolean;
  v_created timestamptz;
  v_tz text;
  v_today date;
  v_today_t text;
  v_season int;
  v_s_start timestamptz;
  v_s_end timestamptz;
  v_s_first date;
  v_s_last date;
  v_w_end date;
  v_first_t text;
  v_end_t text;
  v_joined date;
  v_this_week text;
  v_first_active date;
  v_from date;
  v_days int;
  v_active int;
  v_card jsonb;
  v_has boolean;
  v_x jsonb;
BEGIN
  IF v_viewer IS NULL OR p_member IS NULL THEN
    RETURN NULL;
  END IF;

  -- The visibility rule of ascend_member_profiles, unchanged.
  SELECT coalesce(pr.is_profile_public, true) INTO v_viewer_public
  FROM public.profiles pr WHERE pr.id = v_viewer;

  SELECT (
           p.id = v_viewer
           OR (coalesce(v_viewer_public, true) AND coalesce(p.is_profile_public, true))
           OR EXISTS (
             SELECT 1 FROM public.partnerships ps
             WHERE (ps.user1_id = v_viewer AND ps.user2_id = p.id)
                OR (ps.user2_id = v_viewer AND ps.user1_id = p.id)
           )
         ),
         p.created_at
    INTO v_allowed, v_created
  FROM public.profiles p
  WHERE p.id = p_member;

  IF v_allowed IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  -- Clocks: the member's own day; the season from the shared UTC boundaries.
  v_tz := public.ascend_user_timezone(p_member);
  v_today := (now() AT TIME ZONE v_tz)::date;
  v_today_t := to_char(v_today, 'YYYY-MM-DD');
  v_season := public.ascend_season_number(now());
  v_s_start := public.ascend_season_begin(v_season);
  v_s_end := public.ascend_season_begin(v_season + 1);
  v_s_first := (v_s_start AT TIME ZONE 'UTC')::date;
  v_s_last := (v_s_end AT TIME ZONE 'UTC')::date - 1;
  -- Behind UTC right after a rollover the member's today can still be before the new season's first
  -- day: the window is then empty (never negative).
  v_w_end := least(v_today, v_s_last);
  v_first_t := to_char(v_s_first, 'YYYY-MM-DD');
  v_end_t := to_char(v_w_end, 'YYYY-MM-DD');
  v_joined := (coalesce(v_created, now()) AT TIME ZONE v_tz)::date;
  v_this_week := public.ascend_week_key(v_today, v_tz);

  v_card := jsonb_build_object('v', 2);

  -- Active days: any habit check-in, exercise, skill, reading, focus or journal day in the window.
  -- Day keys stay text ('YYYY-MM-DD' sorts like a date), so a malformed key can never raise.
  WITH win AS (
    SELECT d::date AS d, to_char(d, 'YYYY-MM-DD') AS k
    FROM generate_series(v_s_first, v_w_end, interval '1 day') d
  ), days AS (
    -- daily habits: the completion keys of days in the window
    SELECT w.k
    FROM public.habits h
    JOIN win w ON CASE jsonb_typeof(h.data->'completions')
                    WHEN 'object' THEN coalesce(h.data->'completions'->w.k->>'done', '') = 'true'
                    WHEN 'array'  THEN (h.data->'completions') ? w.k
                    ELSE false END
    WHERE h.user_id = p_member AND h.deleted_at IS NULL
      AND coalesce(h.data->>'frequency', 'daily') <> 'weekly'
      AND w.k >= CASE WHEN h.data->>'createdAtPeriod' ~ '^\d{4}-\d{2}-\d{2}$'
                      THEN greatest(v_first_t, h.data->>'createdAtPeriod') ELSE v_first_t END
    UNION
    -- weekly habits: the day the week was ticked (in the member's timezone)
    SELECT to_char(public.ascend_instant(c.value->>'updatedAt') AT TIME ZONE v_tz, 'YYYY-MM-DD')
    FROM public.habits h
    CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(h.data->'completions') = 'object'
                                       THEN h.data->'completions' ELSE '{}'::jsonb END) c
    WHERE h.user_id = p_member AND h.deleted_at IS NULL AND h.data->>'frequency' = 'weekly'
      AND c.key ~ '^\d{4}-W\d{2}$' AND (c.value->>'done') = 'true'
    UNION
    SELECT x.data->>'date' FROM public.workouts x WHERE x.user_id = p_member AND x.deleted_at IS NULL
    UNION
    SELECT x.data->>'date' FROM public.skill_logs x WHERE x.user_id = p_member AND x.deleted_at IS NULL
    UNION
    SELECT x.data->>'date' FROM public.reading_logs x WHERE x.user_id = p_member AND x.deleted_at IS NULL
    UNION
    SELECT to_char(x.log_date, 'YYYY-MM-DD') FROM public.focus_logs x WHERE x.user_id = p_member AND x.deleted_at IS NULL
    UNION
    SELECT to_char(x.entry_date, 'YYYY-MM-DD') FROM public.journal_entries x WHERE x.user_id = p_member AND x.deleted_at IS NULL
  )
  SELECT count(*)::int, min(w.d)
    INTO v_active, v_first_active
  FROM (SELECT DISTINCT k FROM days) dd
  JOIN win w ON w.k = dd.k;

  -- Since the season's first day, or since joining when later (a guest's earlier first log counts).
  v_from := greatest(v_s_first, least(v_joined, coalesce(v_first_active, v_joined)));
  v_days := greatest(1, v_w_end - v_from + 1);

  v_card := v_card || jsonb_build_object(
    'season', v_season,
    'seasonStart', to_char(v_s_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'seasonEnd', to_char(v_s_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'asOf', v_today_t,
    'from', to_char(v_from, 'YYYY-MM-DD'),
    'days', v_days,
    'active', least(v_active, v_days)
  );

  -- Today: habits ticked on the member's local today (the Partners page).
  SELECT to_jsonb(count(*)::int) INTO v_x
  FROM public.habits h
  WHERE h.user_id = p_member AND h.deleted_at IS NULL
    AND CASE jsonb_typeof(h.data->'completions')
          WHEN 'object' THEN coalesce(h.data->'completions'->v_today_t->>'done', '') = 'true'
          WHEN 'array'  THEN (h.data->'completions') ? v_today_t
          ELSE false END;
  v_card := v_card || jsonb_build_object('today', jsonb_build_object('habitsDone', coalesce(v_x, '0'::jsonb)));

  -- Current streak: the longest run ending today or yesterday over each active habit's check-ins,
  -- exercise days, reading days, resisted days of each bad habit still being fought, and skill days.
  -- Ties go to the higher priority (habit 100, exercise 80, reading 60, resisted 40, skill 20).
  WITH keys AS (
    SELECT 'h:' || h.id AS src, coalesce(nullif(btrim(h.data->>'category'), ''), 'Habit Journey') AS cat, 100 AS prio, c.k
    FROM public.habits h
    CROSS JOIN LATERAL (
      SELECT e.key AS k FROM jsonb_each(CASE WHEN jsonb_typeof(h.data->'completions') = 'object'
                                             THEN h.data->'completions' ELSE '{}'::jsonb END) e
      WHERE (e.value->>'done') = 'true'
      UNION
      SELECT a.value FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(h.data->'completions') = 'array'
                                                         THEN h.data->'completions' ELSE '[]'::jsonb END) a
    ) c
    WHERE h.user_id = p_member AND h.deleted_at IS NULL
    UNION ALL
    SELECT 'exercise', 'Exercise', 80, x.data->>'date' FROM public.workouts x
    WHERE x.user_id = p_member AND x.deleted_at IS NULL
    UNION ALL
    SELECT 'reading', 'Reading', 60, x.data->>'date' FROM public.reading_logs x
    WHERE x.user_id = p_member AND x.deleted_at IS NULL
    UNION ALL
    SELECT 'b:' || b.id, 'Resisted', 40, l.data->>'date'
    FROM public.bad_habits b
    JOIN public.bad_habit_logs l ON l.user_id = b.user_id AND l.deleted_at IS NULL
     AND l.data->>'badHabitId' = b.id AND l.data->>'status' = 'resisted'
    WHERE b.user_id = p_member AND b.deleted_at IS NULL
      AND coalesce(b.data->>'isCompleted', 'false') <> 'true'
    UNION ALL
    SELECT 'skill', 'Skill Practice', 20, x.data->>'date' FROM public.skill_logs x
    WHERE x.user_id = p_member AND x.deleted_at IS NULL
  ), dated AS (
    -- Only real calendar days on or before today; nested CASE so a malformed key is never cast.
    SELECT DISTINCT src, cat, prio,
      CASE WHEN k ~ '^[12]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$' AND k <= v_today_t THEN
        CASE WHEN substr(k, 9, 2)::int <= extract(day FROM (make_date(substr(k, 1, 4)::int, substr(k, 6, 2)::int, 1)
                                                            + interval '1 month - 1 day'))::int
             THEN k::date END
      END AS day
    FROM keys
  ), runs AS (
    SELECT src, cat, prio, day, day - (row_number() OVER (PARTITION BY src ORDER BY day))::int AS grp
    FROM dated WHERE day IS NOT NULL
  ), islands AS (
    SELECT src, cat, prio, count(*)::int AS n, max(day) AS last FROM runs GROUP BY src, cat, prio, grp
  )
  SELECT jsonb_build_object('days', i.n, 'category', i.cat)
    INTO v_x
  FROM islands i
  WHERE i.last >= v_today - 1
  ORDER BY i.n DESC, i.prio DESC
  LIMIT 1;
  v_card := v_card || jsonb_build_object('streak', coalesce(v_x, jsonb_build_object('days', 0, 'category', '')));

  -- Habits: share of check-ins done. A daily habit is due each day from its creation; a weekly one
  -- each week touching the window from its creation week. Today (this week) counts only once done.
  SELECT EXISTS (SELECT 1 FROM public.habits h WHERE h.user_id = p_member AND h.deleted_at IS NULL) INTO v_has;
  IF v_has THEN
    WITH win AS (
      SELECT to_char(d, 'YYYY-MM-DD') AS k, public.ascend_week_key(d::date, v_tz) AS wk
      FROM generate_series(v_s_first, v_w_end, interval '1 day') d
    ), daily AS (
      SELECT CASE jsonb_typeof(h.data->'completions')
               WHEN 'object' THEN coalesce(h.data->'completions'->w.k->>'done', '') = 'true'
               WHEN 'array'  THEN (h.data->'completions') ? w.k
               ELSE false END AS done, w.k = v_today_t AS is_now
      FROM public.habits h
      JOIN win w ON w.k >= CASE WHEN h.data->>'createdAtPeriod' ~ '^\d{4}-\d{2}-\d{2}$'
                                THEN greatest(v_first_t, h.data->>'createdAtPeriod') ELSE v_first_t END
      WHERE h.user_id = p_member AND h.deleted_at IS NULL
        AND coalesce(h.data->>'frequency', 'daily') <> 'weekly'
    ), weekly AS (
      SELECT CASE jsonb_typeof(h.data->'completions')
               WHEN 'object' THEN coalesce(h.data->'completions'->ww.wk->>'done', '') = 'true'
               WHEN 'array'  THEN (h.data->'completions') ? ww.wk
               ELSE false END AS done, ww.wk = v_this_week AS is_now
      FROM public.habits h
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN h.data->>'createdAtPeriod' ~ '^\d{4}-W\d{2}$' THEN h.data->>'createdAtPeriod'
          WHEN h.data->>'createdAtPeriod' ~ '^[12]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$' THEN
            CASE WHEN substr(h.data->>'createdAtPeriod', 9, 2)::int <= extract(day FROM (make_date(
                        substr(h.data->>'createdAtPeriod', 1, 4)::int, substr(h.data->>'createdAtPeriod', 6, 2)::int, 1)
                        + interval '1 month - 1 day'))::int
                 THEN public.ascend_week_key((h.data->>'createdAtPeriod')::date, v_tz) END
        END AS created_week
      ) cw
      JOIN (SELECT DISTINCT wk FROM win) ww ON cw.created_week IS NULL OR ww.wk >= cw.created_week
      WHERE h.user_id = p_member AND h.deleted_at IS NULL AND h.data->>'frequency' = 'weekly'
    ), checks AS (
      SELECT done, is_now FROM daily UNION ALL SELECT done, is_now FROM weekly
    )
    SELECT jsonb_build_object(
             'done', count(*) FILTER (WHERE done),
             'due', count(*) FILTER (WHERE done OR NOT is_now))
      INTO v_x
    FROM checks;
    v_card := v_card || jsonb_build_object('habits', v_x);
  END IF;

  -- Exercise: the 3 most-done exercises, one row per exercise and unit (never added across units),
  -- ranked by days, then sessions, then the newest; newest spelling; best = the largest one-day total.
  SELECT EXISTS (SELECT 1 FROM public.workouts x WHERE x.user_id = p_member AND x.deleted_at IS NULL) INTO v_has;
  IF v_has THEN
    WITH ex AS (
      SELECT lower(regexp_replace(coalesce(x.data->>'type', ''), '[^[:alnum:]]+', '', 'g')) AS gk,
             nullif(btrim(coalesce(x.data->>'type', '')), '') AS name,
             CASE WHEN lower(btrim(coalesce(x.data->>'unit', 'mins'))) IN ('reps', 'sets', 'km')
                  THEN lower(btrim(x.data->>'unit')) ELSE 'mins' END AS unit,
             x.data->>'date' AS day,
             coalesce(x.data->>'createdAt', '') AS created,
             CASE WHEN jsonb_typeof(x.data->'amount') = 'number' THEN (x.data->>'amount')::numeric END AS amount,
             CASE WHEN jsonb_typeof(x.data->'durationMinutes') = 'number' THEN (x.data->>'durationMinutes')::numeric END AS minutes
      FROM public.workouts x
      WHERE x.user_id = p_member AND x.deleted_at IS NULL
        AND x.data->>'date' >= v_first_t AND x.data->>'date' <= v_end_t
        AND x.data->>'date' ~ '^\d{4}-\d{2}-\d{2}$'
    ), ex_amt AS (
      SELECT gk, name, unit, day, created,
             greatest(CASE WHEN unit = 'mins' THEN CASE WHEN amount > 0 THEN amount ELSE coalesce(minutes, 0) END
                           ELSE coalesce(amount, 0) END, 0) AS amt
      FROM ex
    ), per_day AS (
      SELECT gk, unit, day, sum(amt) AS amt, count(*) AS n FROM ex_amt GROUP BY gk, unit, day
    ), grp AS (
      SELECT d.gk, d.unit, sum(d.amt) AS total, count(*)::int AS days, max(d.amt) AS best, sum(d.n) AS sessions,
             max(d.day) AS newest
      FROM per_day d GROUP BY d.gk, d.unit
    ), named AS (
      SELECT g.*,
             (SELECT left(coalesce(a.name, 'Workout'), 40) FROM ex_amt a
              WHERE a.gk = g.gk AND a.unit = g.unit
              ORDER BY a.day DESC, a.created DESC LIMIT 1) AS name,
             (SELECT max(a.day || '|' || a.created) FROM ex_amt a WHERE a.gk = g.gk AND a.unit = g.unit) AS stamp
      FROM grp g
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'name', t.name, 'unit', t.unit, 'total', round(t.total, 2), 'days', t.days, 'best', round(t.best, 2))
             ORDER BY t.days DESC, t.sessions DESC, t.stamp DESC), '[]'::jsonb)
      INTO v_x
    FROM (SELECT * FROM named ORDER BY days DESC, sessions DESC, stamp DESC LIMIT 3) t;
    v_card := v_card || jsonb_build_object('exercise', v_x);
  END IF;

  -- Skills: practice minutes and days only. Skill names stay private. (Cleared lifetime minutes are
  -- undated, so they are not part of a season figure.)
  SELECT EXISTS (SELECT 1 FROM public.skills s WHERE s.user_id = p_member AND s.deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM public.skill_logs x WHERE x.user_id = p_member AND x.deleted_at IS NULL) INTO v_has;
  IF v_has THEN
    SELECT jsonb_build_object(
             'minutes', coalesce(round(sum(CASE WHEN jsonb_typeof(x.data->'durationMinutes') = 'number'
                                                THEN greatest((x.data->>'durationMinutes')::numeric, 0) ELSE 0 END)), 0),
             'days', count(DISTINCT x.data->>'date'))
      INTO v_x
    FROM public.skill_logs x
    WHERE x.user_id = p_member AND x.deleted_at IS NULL
      AND x.data->>'date' >= v_first_t AND x.data->>'date' <= v_end_t
      AND x.data->>'date' ~ '^\d{4}-\d{2}-\d{2}$';
    v_card := v_card || jsonb_build_object('skills', v_x);
  END IF;

  -- Reading: days read (a Finish log counts as a reading day), books finished this season, and the
  -- amount in each unit the member logged (Zakria 2026-11-12, 20261112210000): pages = page logs,
  -- chapters = chapter logs to a tenth (each log rounded to its tenth first, like the page award),
  -- never converted; a unit at 0 is left out. A log counts in its own unit, else its book's (a book
  -- can switch units, 20261109190000), and only for a book still in the library; Finish logs don't.
  SELECT EXISTS (SELECT 1 FROM public.reading_books b WHERE b.user_id = p_member AND b.deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM public.reading_logs x WHERE x.user_id = p_member AND x.deleted_at IS NULL) INTO v_has;
  IF v_has THEN
    WITH logs AS (
      SELECT x.data->>'date' AS day,
             coalesce(x.data->'finish' NOT IN ('false'::jsonb, 'null'::jsonb, '0'::jsonb, '""'::jsonb), false) AS finish,
             public.ascend_reading_log_pages(x.data) AS amount,
             (
               SELECT CASE WHEN lower(x.data->>'unit') IN ('pages', 'chapters') THEN lower(x.data->>'unit')
                           ELSE lower(coalesce(nullif(b.data->>'unit', ''), 'pages')) END
               FROM public.reading_books b
               WHERE b.user_id = p_member AND b.deleted_at IS NULL
                 AND coalesce(x.data->>'bookId', '') <> ''
                 AND (b.id = x.data->>'bookId' OR b.data->>'linkedBookId' = x.data->>'bookId')
               ORDER BY (b.id = x.data->>'bookId') DESC, b.id
               LIMIT 1
             ) AS unit
      FROM public.reading_logs x
      WHERE x.user_id = p_member AND x.deleted_at IS NULL
        AND x.data->>'date' >= v_first_t AND x.data->>'date' <= v_end_t
        AND x.data->>'date' ~ '^\d{4}-\d{2}-\d{2}$'
    ), agg AS (
      SELECT count(DISTINCT day)::int AS days,
             coalesce(round(sum(amount) FILTER (WHERE NOT finish AND unit = 'pages')), 0) AS pages,
             coalesce(round(sum(round(amount * 10)) FILTER (WHERE NOT finish AND unit = 'chapters') / 10, 1), 0) AS chapters
      FROM logs
    )
    SELECT jsonb_build_object(
             'days', a.days,
             'booksThisSeason', (
               SELECT count(*)::int FROM public.reading_books b
               WHERE b.user_id = p_member AND b.deleted_at IS NULL
                 AND (b.data->>'status' = 'completed' OR b.data->>'isFinished' = 'true')
                 AND public.ascend_instant(coalesce(b.data->>'completedAt', b.data->>'dateCompleted')) >= v_s_start
                 AND public.ascend_instant(coalesce(b.data->>'completedAt', b.data->>'dateCompleted')) < v_s_end))
           || CASE WHEN a.pages > 0 THEN jsonb_build_object('pages', a.pages) ELSE '{}'::jsonb END
           || CASE WHEN a.chapters > 0 THEN jsonb_build_object('chapters', a.chapters) ELSE '{}'::jsonb END
      INTO v_x
    FROM agg a;
    v_card := v_card || jsonb_build_object('reading', v_x);
  END IF;

  -- Focus (Deep Focus / Prefrontal Cortex timer): minutes and sessions.
  SELECT EXISTS (SELECT 1 FROM public.focus_logs x WHERE x.user_id = p_member AND x.deleted_at IS NULL) INTO v_has;
  IF v_has THEN
    SELECT jsonb_build_object('minutes', coalesce(sum(greatest(x.duration_minutes, 0)), 0), 'sessions', count(*))
      INTO v_x
    FROM public.focus_logs x
    WHERE x.user_id = p_member AND x.deleted_at IS NULL AND x.log_date BETWEEN v_s_first AND v_w_end;
    v_card := v_card || jsonb_build_object('focus', v_x);
  END IF;

  -- Journal: days with an entry only. Never content or mood.
  SELECT EXISTS (SELECT 1 FROM public.journal_entries x WHERE x.user_id = p_member AND x.deleted_at IS NULL) INTO v_has;
  IF v_has THEN
    SELECT jsonb_build_object('days', count(DISTINCT x.entry_date))
      INTO v_x
    FROM public.journal_entries x
    WHERE x.user_id = p_member AND x.deleted_at IS NULL AND x.entry_date BETWEEN v_s_first AND v_w_end;
    v_card := v_card || jsonb_build_object('journal', v_x);
  END IF;

  RETURN v_card;
END;
$function$;
