-- CR-09-10 (2026-11-17): habit awards use the same default as penalty processing for a habit with
-- no `frequency`: missing = daily (ascend_process_penalties: coalesce(v_habit.data->>'frequency', 'daily')).
-- Before this, awards treated a missing frequency as NOT daily (0 points, skipped).
--
-- Both functions are CREATE OR REPLACE of the LIVE body (pg_get_functiondef, read 2026-11-17) with
-- only that default changed. No signature change; CREATE OR REPLACE keeps owner (postgres), ACL
-- (postgres, service_role EXECUTE), SECURITY DEFINER (recompute only) and search_path '' as live.
--   ascend_preset_habit_points     custom habit: daily -> 1 point; now missing frequency also -> 1
--   ascend_recompute_habit_awards  daily-habit filter; now missing frequency also counts as daily
-- Client mirror: src/lib/points/habitAwards.ts (isDailyHabit), capStatus.ts, actions/useHabitActions.ts.
--
-- Effect today: none. 0 of 82 live habits lack `frequency` (checked 2026-11-17), and the app type
-- requires it. Prod-compatible; apply any time (no app change needed first).
-- Rollback: re-run the same two functions with `coalesce(..., 'daily') = 'daily'` back to
--   `->>'frequency' = 'daily'` (live copies: work/cr-gap-live/fn_185254.sql, fn_185257.sql).

CREATE OR REPLACE FUNCTION public.ascend_preset_habit_points(p_habit jsonb)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE WHEN coalesce(p_habit->>'isPreset', '') <> 'true' THEN
    CASE WHEN coalesce(p_habit->>'frequency', 'daily') = 'daily' THEN 1 ELSE 0 END -- CUSTOM_HABIT_POINTS, daily only
  ELSE
    CASE p_habit->>'name'
      WHEN 'Drink 8 cups of water' THEN 1
      WHEN 'Sleep 7-8 hours' THEN 2
      WHEN 'Morning walk' THEN 1
      WHEN 'Cold shower' THEN 2
      WHEN 'Stretching / mobility' THEN 1
      WHEN '10,000 steps' THEN 2
      WHEN 'Eat fruits / vegetables' THEN 1
      WHEN 'No eating after 9 pm' THEN 1
      WHEN 'Morning sunlight' THEN 1
      WHEN 'Meditation' THEN 2
      WHEN 'Gratitude (3 things)' THEN 1
      WHEN 'Plan tomorrow tonight' THEN 1
      WHEN 'Pray / spiritual practice' THEN 2
      WHEN 'Learn something new' THEN 3
      WHEN 'Listen to educational podcast' THEN 2
      WHEN 'Learn 5 new words' THEN 1
      WHEN 'Watch a lecture / tutorial' THEN 2
      WHEN 'Wake up early' THEN 2
      WHEN 'Make your bed' THEN 1
      WHEN 'Tidy up for 10 minutes' THEN 1
      ELSE 0
    END
  END;
$function$;


CREATE OR REPLACE FUNCTION public.ascend_recompute_habit_awards(p_user uuid, p_day date, p_tz text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_key       text        := to_char(p_day, 'YYYY-MM-DD');
  v_day_start timestamptz := p_day::timestamp AT TIME ZONE p_tz;
  v_cap       int         := 10; -- PRESET_HABIT_POINTS.dailyCap
  v_used      int         := 0;
  v_alloc     int;
  v_at        timestamptz;
  v_id        text;
  v_kept      text[]      := '{}';
  v_item      record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('habit_awards:' || p_user::text || ':' || v_key));

  -- Checked daily presets of the day, one per preset name (the earliest), in check order.
  FOR v_item IN
    SELECT * FROM (
      SELECT DISTINCT ON (h.data->>'name')
        h.id,
        h.data->>'name' AS name,
        h.data->>'category' AS category,
        public.ascend_preset_habit_points(h.data) AS points,
        coalesce(
          public.ascend_instant(h.data->'completions'->v_key->>'updatedAt'),
          public.ascend_instant(h.data->>'updatedAt'),
          public.ascend_instant(h.data->>'createdAt')
        ) AS checked_at
      FROM public.habits h
      WHERE h.user_id = p_user
        AND h.deleted_at IS NULL
        AND coalesce(h.data->>'frequency', 'daily') = 'daily'
        AND public.ascend_preset_habit_points(h.data) > 0
        AND CASE jsonb_typeof(h.data->'completions')
              WHEN 'object' THEN coalesce(h.data->'completions'->v_key->>'done', '') = 'true'
              WHEN 'array'  THEN (h.data->'completions') ? v_key
              ELSE false END
      ORDER BY h.data->>'name', 5 NULLS LAST, h.id COLLATE "C"
    ) d
    ORDER BY d.checked_at NULLS LAST, d.id COLLATE "C"
  LOOP
    v_alloc := least(v_item.points, greatest(v_cap - v_used, 0));
    v_used := v_used + v_alloc;
    CONTINUE WHEN v_alloc <= 0;

    v_id := 'habit_award_' || v_item.id || '_' || v_key;
    v_kept := array_append(v_kept, v_id);
    v_at := least(greatest(coalesce(v_item.checked_at, now()), v_day_start), now());

    INSERT INTO public.point_entries AS pe (user_id, id, data, created_at, updated_at)
    VALUES (p_user, v_id, jsonb_build_object(
      'id', v_id,
      'amount', v_alloc,
      'reason', 'Habit completed: ' || v_item.name,
      'source', 'habit_completed',
      'timestamp', to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'metadata', jsonb_strip_nulls(jsonb_build_object(
        'category', v_item.category,
        'habitId', v_item.id,
        'habitName', v_item.name,
        'periodKey', v_key
      ))
    ), now(), now())
    ON CONFLICT (user_id, id) DO UPDATE
      SET data = EXCLUDED.data, deleted_at = NULL, updated_at = greatest(now(), pe.updated_at)
      WHERE pe.data IS DISTINCT FROM EXCLUDED.data OR pe.deleted_at IS NOT NULL;
  END LOOP;

  -- Awards that no longer hold, and the app-written awards of the day (before this migration).
  UPDATE public.point_entries pe
  SET deleted_at = now(), updated_at = greatest(now(), pe.updated_at)
  WHERE pe.user_id = p_user
    AND pe.deleted_at IS NULL
    AND pe.data->'metadata'->>'periodKey' = v_key
    AND (
      (pe.id LIKE 'habit\_award\_%' AND NOT pe.id = ANY (v_kept))
      OR (pe.id NOT LIKE 'habit\_award\_%' AND pe.data->>'source' IN ('habit_completed', 'habit_cap_redistribution'))
    );
END;
$function$;

