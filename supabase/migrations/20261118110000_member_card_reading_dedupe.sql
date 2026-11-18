-- Member card: reading pages/chapters count pages logged twice from the same place once (2026-11-18).
-- Order: any time (only a shown number changes); apply BEFORE the studio test to see it there. Not applied.
--
-- Since 20261117173000_reading_awards_dedupe_ranges.sql (live) the page award counts a log with a start
-- place (data.fromAmount) only for the part of its range that earlier logs of the same book, unit and
-- read (data.readStartedAt) did not already cover that day; a unit switch starts the book's ranges over.
-- The member card still summed raw pagesRead, so two devices logging 20 -> 30 showed 20 pages.
--
-- 1. New ascend_reading_log_counted(user, first day, last day): every live log of those days with
--    the amount it counts, in its own unit (pages; chapters to a tenth). Same rule and order as the
--    award's loop (day, time NULLS LAST, logs before switches, id byte order). Unlike the award it
--    keeps Finish logs and logs of removed books (callers filter them); a Finish log and a log without
--    fromAmount count in full and cover nothing. Mirror: src/lib/points/readingAwards.ts
--    countedReadingAmounts (same rule as computeReadingDayAward). Read-only (STABLE); not callable
--    by clients (service_role only; the SECURITY DEFINER member card calls it as its owner).
-- 2. ascend_member_card: the live body (read 2026-11-18, = 20261114130000 CR-10-15) with the
--    reading amount taken from (1). Nothing else changes; grants re-stated as live.
--
-- No live number changes when this is applied: no live log has fromAmount yet (0 of 58, 2026-11-18),
-- and logs without it count exactly as before. Works with app 1.4.1 (its logs have no fromAmount).

CREATE OR REPLACE FUNCTION public.ascend_reading_log_counted(p_user uuid, p_first text, p_last text)
 RETURNS TABLE(log_id text, amount numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_item   record;
  v_day    text;
  v_cov    jsonb := '{}'::jsonb; -- per book, per range key (unit|readStartedAt): covered [lo, hi] of the day
  v_ckey   text;
  v_ranges jsonb;
  v_keep   jsonb;
  v_range  record;
  v_lo     numeric;
  v_hi     numeric;
  v_mlo    numeric;
  v_mhi    numeric;
  v_added  numeric;
BEGIN
  FOR v_item IN
    SELECT ev.kind, ev.day, ev.book_id, ev.log_id, ev.lunit, ev.from_amt, ev.amt, ev.cycle
    FROM (
      SELECT 0 AS kind,
             l.data->>'date' AS day,
             coalesce(l.data->>'bookId', '') AS book_id,
             l.id AS log_id,
             l.id AS ord_id,
             public.ascend_instant(l.data->>'createdAt') AS logged_at,
             CASE WHEN lower(l.data->>'unit') IN ('pages', 'chapters') THEN lower(l.data->>'unit')
                  WHEN lower(b.data->>'unit') = 'chapters' THEN 'chapters' ELSE 'pages' END AS lunit,
             -- The place the log started from (app after 1.4.1); NULL = counted in full. A Finish log never covers.
             CASE WHEN jsonb_typeof(l.data->'fromAmount') = 'number' AND (l.data->>'fromAmount')::numeric >= 0
                       AND (l.data->'finish') IS DISTINCT FROM 'true'::jsonb
                  THEN (l.data->>'fromAmount')::numeric END AS from_amt,
             public.ascend_reading_log_pages(l.data) AS amt,
             CASE WHEN jsonb_typeof(l.data->'readStartedAt') = 'string' THEN l.data->>'readStartedAt' ELSE '' END AS cycle
      FROM public.reading_logs l
      LEFT JOIN public.reading_books b
        ON b.user_id = l.user_id AND b.id = l.data->>'bookId' AND b.deleted_at IS NULL
      WHERE l.user_id = p_user
        AND l.deleted_at IS NULL
        AND l.data->>'date' >= p_first AND l.data->>'date' <= p_last
      UNION ALL
      SELECT 1,
             s.e->>'date',
             b.id,
             NULL::text,
             b.id || '#' || s.ord,
             public.ascend_instant(s.e->>'at'),
             NULL::text, NULL::numeric, NULL::numeric, NULL::text
      FROM public.reading_books b
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(b.data->'unitSwitches') = 'array' THEN b.data->'unitSwitches' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS s(e, ord)
      WHERE b.user_id = p_user
        AND b.deleted_at IS NULL
        AND jsonb_typeof(s.e) = 'object'
        AND s.e->>'date' >= p_first AND s.e->>'date' <= p_last
        AND jsonb_typeof(s.e->'pagesBefore') = 'number'
        AND jsonb_typeof(s.e->'pagesAfter') = 'number'
    ) ev
    ORDER BY ev.day COLLATE "C", ev.logged_at NULLS LAST, ev.kind, ev.ord_id COLLATE "C"
  LOOP
    IF v_day IS DISTINCT FROM v_item.day THEN
      v_cov := '{}'::jsonb; -- ranges are per day
      v_day := v_item.day;
    END IF;
    IF v_item.kind = 1 THEN
      v_cov := v_cov - v_item.book_id; -- a unit switch starts the book's covered ranges over
      CONTINUE;
    END IF;
    log_id := v_item.log_id;
    IF v_item.from_amt IS NULL THEN
      amount := CASE WHEN v_item.lunit = 'chapters' THEN round(v_item.amt * 10) / 10 ELSE v_item.amt END;
      RETURN NEXT;
      CONTINUE;
    END IF;
    -- Only the part of this log's range no earlier log of this book, unit and read covered that day.
    IF v_item.lunit = 'chapters' THEN
      v_lo := round(v_item.from_amt * 10);
      v_hi := v_lo + round(v_item.amt * 10);
    ELSE
      v_lo := v_item.from_amt;
      v_hi := v_lo + v_item.amt;
    END IF;
    v_ckey := v_item.lunit || '|' || v_item.cycle;
    v_ranges := coalesce(v_cov->v_item.book_id->v_ckey, '[]'::jsonb);
    v_added := v_hi - v_lo;
    v_mlo := v_lo;
    v_mhi := v_hi;
    v_keep := '[]'::jsonb;
    FOR v_range IN SELECT (r.e->>0)::numeric AS lo, (r.e->>1)::numeric AS hi FROM jsonb_array_elements(v_ranges) AS r(e) LOOP
      v_added := v_added - greatest(least(v_hi, v_range.hi) - greatest(v_lo, v_range.lo), 0);
      IF v_range.hi < v_lo OR v_range.lo > v_hi THEN
        v_keep := v_keep || jsonb_build_array(jsonb_build_array(v_range.lo, v_range.hi));
      ELSE
        v_mlo := least(v_mlo, v_range.lo);
        v_mhi := greatest(v_mhi, v_range.hi);
      END IF;
    END LOOP;
    v_cov := v_cov || jsonb_build_object(v_item.book_id,
      coalesce(v_cov->v_item.book_id, '{}'::jsonb) || jsonb_build_object(v_ckey, v_keep || jsonb_build_array(jsonb_build_array(v_mlo, v_mhi))));
    amount := CASE WHEN v_item.lunit = 'chapters' THEN greatest(v_added, 0) / 10 ELSE greatest(v_added, 0) END;
    RETURN NEXT;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.ascend_reading_log_counted(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ascend_reading_log_counted(uuid, text, text) TO service_role;

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
  -- Each log adds what it counts (ascend_reading_log_counted, 20261118110000): pages logged again
  -- from the same place the same day (two devices) count once, as for the page award; older logs
  -- (no fromAmount) count in full.
  SELECT EXISTS (SELECT 1 FROM public.reading_books b WHERE b.user_id = p_member AND b.deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM public.reading_logs x WHERE x.user_id = p_member AND x.deleted_at IS NULL) INTO v_has;
  IF v_has THEN
    WITH logs AS (
      SELECT x.data->>'date' AS day,
             coalesce(x.data->'finish' NOT IN ('false'::jsonb, 'null'::jsonb, '0'::jsonb, '""'::jsonb), false) AS finish,
             coalesce(c.amount, public.ascend_reading_log_pages(x.data)) AS amount,
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
      LEFT JOIN public.ascend_reading_log_counted(p_member, v_first_t, v_end_t) c ON c.log_id = x.id
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

REVOKE ALL ON FUNCTION public.ascend_member_card(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ascend_member_card(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.ascend_member_card(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ascend_member_card(uuid) TO service_role;
