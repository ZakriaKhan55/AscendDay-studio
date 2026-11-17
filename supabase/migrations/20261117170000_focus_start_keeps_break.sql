-- Focus: a session started offline that is on a break when it is first uploaded keeps its break
-- (2026-11-17). Before, ascend_focus_session_start always wrote pause_ends_at = NULL and break_count = 0,
-- so such a session arrived as a plain pause (30-min resume window instead of break end + 10 min), and
-- breaks taken offline did not count toward the max of 2.
-- Only ascend_focus_session_start changes (same signature, p_session jsonb). It now reads two optional
-- keys the new app sends:
--   * breakCount (number): breaks taken in this session, clamped 0..2 -> break_count.
--   * pauseEndsAt (number, ms): while paused, the end of the break it is on -> pause_ends_at, only when
--     the break is 5/10/15 min (+-1 s) and allowed by the break rules (planned 35+, 25 focused, 5 min
--     left); the break it is on then counts (break_count >= 1). Otherwise it stays a plain pause.
-- An older app sends neither key: exactly the old result. A break past break end + 10 min is ended
-- 'expired' at the break start by ascend_focus_session_locked right after the insert, as for any break.
-- Re-runnable.

CREATE OR REPLACE FUNCTION public.ascend_focus_session_start(p_session jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user      uuid := auth.uid();
  r           public.focus_active_sessions;
  v_prev      jsonb;
  v_id        text := nullif(btrim(p_session->>'id'), '');
  v_focus     integer;
  v_break     integer;
  v_started   timestamptz;
  v_stretch   timestamptz;
  v_planned   numeric;
  v_paused    boolean := coalesce((p_session->>'isPaused')::boolean, false);
  v_paused_at timestamptz;
  v_remain    numeric;
  v_marks     timestamptz[];
  v_shift     interval := interval '0';
  v_floor     timestamptz := now() - interval '24 hours';
  v_rev       integer;
  -- Uploaded by an app that has the break (2026-11-17): the breaks it took, and the end of the break
  -- it is on. An older app sends neither key: plain pause, break_count 0, as before.
  v_breaks    integer := CASE WHEN jsonb_typeof(p_session->'breakCount') = 'number'
                              THEN least(2, greatest(0, round((p_session->>'breakCount')::numeric)))::integer ELSE 0 END;
  v_break_ms  numeric;
  v_break_len integer;
  v_ends_at   timestamptz;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501'; END IF;
  IF v_id IS NULL OR length(v_id) > 64 THEN RAISE EXCEPTION 'bad session id' USING ERRCODE = '22023'; END IF;
  r := public.ascend_focus_session_locked(v_user);

  IF r.user_id IS NOT NULL AND r.session_id = v_id THEN
    RETURN public.ascend_focus_session_reply(r, r.status IN ('running', 'paused')); -- already here
  END IF;
  IF r.user_id IS NOT NULL AND r.status IN ('running', 'paused') THEN
    RETURN public.ascend_focus_session_reply(r, false); -- another session is live: never two
  END IF;

  v_focus := least(600, greatest(1, round(coalesce((p_session->>'focusMinutes')::numeric, 25))))::integer;
  v_break := least(120, greatest(0, round(coalesce((p_session->>'breakMinutes')::numeric, 0))))::integer;
  v_started := to_timestamp(coalesce((p_session->>'startedAt')::double precision, 0) / 1000.0);
  v_stretch := to_timestamp(coalesce((p_session->>'startTime')::double precision, 0) / 1000.0);
  v_planned := least(v_focus * 60.0, greatest(0.0, coalesce((p_session->>'plannedDurationSeconds')::numeric, v_focus * 60.0)));
  v_remain := least(v_focus * 60.0, greatest(0.0, coalesce((p_session->>'pausedRemainingSeconds')::numeric, v_planned)));
  v_paused_at := CASE WHEN v_paused THEN to_timestamp(coalesce((p_session->>'pausedAt')::double precision, 0) / 1000.0) END;
  -- On a break: its length must be 5, 10 or 15 min and the break itself allowed (35+ planned,
  -- 25 focused, 5 left), the same rules as ascend_focus_session_break. Otherwise a plain pause.
  IF v_paused AND jsonb_typeof(p_session->'pauseEndsAt') = 'number' AND jsonb_typeof(p_session->'pausedAt') = 'number' THEN
    v_break_ms := (p_session->>'pauseEndsAt')::numeric - (p_session->>'pausedAt')::numeric;
    v_break_len := round(v_break_ms / 60000.0)::integer;
    IF v_break_len NOT IN (5, 10, 15) OR abs(v_break_ms - v_break_len * 60000.0) > 1000
       OR v_focus < 35 OR v_remain < 5 * 60 OR v_focus * 60.0 - v_remain < 25 * 60 THEN
      v_break_len := NULL;
    ELSE
      v_breaks := greatest(v_breaks, 1); -- the break it is on counts (server-counted, max 2)
    END IF;
  END IF;
  SELECT coalesce(array_agg(to_timestamp(x::double precision / 1000.0) ORDER BY x::double precision), '{}')
  INTO v_marks FROM jsonb_array_elements_text(coalesce(p_session->'marksAt', '[]'::jsonb)) AS x;

  -- A fresh start: the device clock may be a little off, so the server's time is used.
  IF v_started > now() - interval '2 minutes' AND v_started <= now() + interval '2 minutes'
     AND NOT v_paused AND v_planned >= v_focus * 60.0 - 1 THEN
    v_started := now(); v_stretch := now(); v_planned := v_focus * 60.0; v_marks := '{}';
  END IF;
  -- Never in the future: move the whole session back so it ends where it would.
  v_shift := greatest(interval '0', greatest(v_started, v_stretch, coalesce(v_paused_at, v_stretch)) - now());
  v_started := v_started - v_shift; v_stretch := v_stretch - v_shift; v_paused_at := v_paused_at - v_shift;
  IF v_started < v_floor OR v_stretch < v_floor THEN
    RETURN public.ascend_focus_session_reply(r, false); -- too old to be a live session
  END IF;
  v_stretch := greatest(v_stretch, v_started);
  IF v_paused THEN v_paused_at := least(greatest(v_paused_at, v_stretch), now()); END IF;
  -- Its end follows the (shifted, clamped) break start, so the grace is break end + 10 min.
  IF v_break_len IS NOT NULL THEN v_ends_at := v_paused_at + make_interval(mins => v_break_len); END IF;
  SELECT coalesce(array_agg(m ORDER BY m), '{}') INTO v_marks
  FROM unnest(v_marks) AS m WHERE m >= v_started AND m <= now();

  IF r.user_id IS NOT NULL AND r.status IN ('break', 'ended') AND NOT r.log_claimed
     AND r.end_reason IN ('finished', 'expired') THEN
    v_prev := to_jsonb(r);
  END IF;
  v_rev := coalesce(r.revision, 0) + 1;

  INSERT INTO public.focus_active_sessions AS t (
    user_id, session_id, status, task_name, skill_id, focus_minutes, break_minutes, is_custom,
    started_at, stretch_started_at, stretch_planned_seconds, paused_at, paused_remaining_seconds,
    marks_at, focus_ended_at, end_reason, log_claimed, revision, updated_at, pause_ends_at, break_count)
  VALUES (
    v_user, v_id, CASE WHEN v_paused THEN 'paused' ELSE 'running' END,
    left(coalesce(nullif(btrim(p_session->>'taskName'), ''), 'Deep Focus'), 200),
    left(nullif(btrim(p_session->>'skillId'), ''), 100),
    v_focus, v_break, coalesce((p_session->>'isCustom')::boolean, false),
    v_started, v_stretch, v_planned, v_paused_at, CASE WHEN v_paused THEN v_remain ELSE v_planned END,
    v_marks, NULL, NULL, false, v_rev, now(), v_ends_at, v_breaks)
  ON CONFLICT (user_id) DO UPDATE SET
    session_id = EXCLUDED.session_id, status = EXCLUDED.status, task_name = EXCLUDED.task_name,
    skill_id = EXCLUDED.skill_id, focus_minutes = EXCLUDED.focus_minutes, break_minutes = EXCLUDED.break_minutes,
    is_custom = EXCLUDED.is_custom, started_at = EXCLUDED.started_at, stretch_started_at = EXCLUDED.stretch_started_at,
    stretch_planned_seconds = EXCLUDED.stretch_planned_seconds, paused_at = EXCLUDED.paused_at,
    paused_remaining_seconds = EXCLUDED.paused_remaining_seconds, marks_at = EXCLUDED.marks_at,
    focus_ended_at = NULL, end_reason = NULL, log_claimed = false, revision = EXCLUDED.revision, updated_at = now(),
    pause_ends_at = EXCLUDED.pause_ends_at, break_count = EXCLUDED.break_count
  RETURNING * INTO r;

  -- An uploaded session may already be past its end or its resume window.
  r := public.ascend_focus_session_locked(v_user);
  RETURN public.ascend_focus_session_reply(r, true, false, v_prev);
END;
$$;

-- Replaced functions keep their grants (CREATE OR REPLACE), restated here.
REVOKE ALL ON FUNCTION public.ascend_focus_session_start(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ascend_focus_session_start(jsonb) TO authenticated, service_role;
