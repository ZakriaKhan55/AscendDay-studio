-- An edit of a skill practice log dated 2+ days ago (note, drill counts) never reached the server
-- (CodeRabbit CR-10-12, 2026-11-14). The app saves every row as an upsert (INSERT ... ON CONFLICT
-- (user_id, id) DO UPDATE). Postgres fires BEFORE INSERT triggers for every upserted row, before the
-- conflict check, so skill_logs_guard_today ran its INSERT path: a date that is not today or
-- yesterday returned NULL, the row was skipped, the UPDATE branch that accepts such an edit
-- (20261105180000_skill_log_edit_keeps_minutes.sql) never ran, and the next pull restored the old
-- log. Same Postgres behaviour as 20261110160000_recovery_guard_upsert_existing.sql.
--
-- skill_logs_guard_today as live on 2026-11-14 (pg_get_functiondef, = 20261105180000), with ONE
-- branch added; everything else is unchanged:
--   * INSERT of an earlier-day log whose id already has a LIVE row of this user, with the same
--     date, skillId, durationMinutes and createdAt as that row, passes the INSERT step. The
--     conflict then turns it into an UPDATE, and the existing UPDATE branch checks the same four
--     fields again against OLD before the note/counts change is written.
-- Still refused, as before: a NEW earlier-day log (no row with that id), an upsert that changes an
-- earlier day's date, skill, minutes or createdAt, and an upsert onto a deleted row. So no
-- back-dated minutes or points: skill points come from durationMinutes only, which stays locked.
-- skill_logs_award_points (AFTER UPDATE) recomputes today (and yesterday in floor mode) with the
-- minutes unchanged, so no point row moves.
--
-- Checked and NOT changed (2026-11-14, live bodies):
--   * reading_logs_guard_today: no earlier-day edit branch at all (INSERT and UPDATE both refuse an
--     earlier day by design), and the app never edits an earlier reading log (only stampLogUnits
--     re-sends old logs, and the server already stamps their unit). Not the same bug.
--   * workouts_guard_today, bad_habit_logs_guard_today: today only for INSERT and UPDATE by design;
--     the app edits today's rows only. Not the same bug.
--
-- Client unchanged; safe for production and studio builds alike. Run any time.
-- Rollback: re-run the skill_logs_guard_today function from
-- 20261105180000_skill_log_edit_keeps_minutes.sql (the live body before this file).

BEGIN;

CREATE OR REPLACE FUNCTION public.skill_logs_guard_today()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_tz    text;
  v_day   date;
  v_today text;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- The writer's own timezone (profiles.timezone is no longer readable by the app's roles).
  v_tz := public.ascend_own_timezone(NEW.user_id);
  v_day := (now() AT TIME ZONE coalesce(v_tz, 'Asia/Karachi'))::date;
  v_today := to_char(v_day, 'YYYY-MM-DD');
  IF NEW.data->>'date' = v_today
     AND (TG_OP = 'INSERT' OR OLD.data->>'date' = v_today)
  THEN
    RETURN NEW;
  END IF;
  -- A new log of yesterday that reaches the server today (made offline before midnight). An upsert
  -- on an id that already exists runs the UPDATE check above next, so it stays refused.
  IF TG_OP = 'INSERT' AND NEW.data->>'date' = to_char(v_day - 1, 'YYYY-MM-DD') THEN
    RETURN NEW;
  END IF;
  -- An upsert of an existing live log (INSERT ... ON CONFLICT DO UPDATE runs this as INSERT first):
  -- passes only when day, skill, minutes and createdAt match the row; the UPDATE pass below checks
  -- them again against OLD (2026-11-14, CR-10-12).
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM public.skill_logs l
    WHERE l.user_id = NEW.user_id AND l.id = NEW.id AND l.deleted_at IS NULL
      AND NEW.data->>'date' IS NOT DISTINCT FROM l.data->>'date'
      AND NEW.data->>'skillId' IS NOT DISTINCT FROM l.data->>'skillId'
      AND (NEW.data->'durationMinutes') IS NOT DISTINCT FROM (l.data->'durationMinutes')
      AND NEW.data->>'createdAt' IS NOT DISTINCT FROM l.data->>'createdAt'
  ) THEN
    RETURN NEW;
  END IF;
  -- An edit of an earlier day's log (note, counts): its day, skill, minutes and createdAt stay as
  -- they are, so its points cannot change (2026-11-05, skill log edit).
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL
     AND NEW.data->>'date' IS NOT DISTINCT FROM OLD.data->>'date'
     AND NEW.data->>'skillId' IS NOT DISTINCT FROM OLD.data->>'skillId'
     AND (NEW.data->'durationMinutes') IS NOT DISTINCT FROM (OLD.data->'durationMinutes')
     AND NEW.data->>'createdAt' IS NOT DISTINCT FROM OLD.data->>'createdAt'
  THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$function$;

COMMIT;
