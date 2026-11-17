-- Pacts: link my side of a running challenge to a habit later (knowledge/mode-a-pact-link-later-2026-11-17.md).
-- Until now a pact side's goal text (user1_target / user2_target, the name it links to a habit or
-- bad habit by) was fixed at creation: shared_challenges_guard copies both targets from OLD on every
-- update, because every app save (save_shared_challenge_atomic, the direct upsert) sends the whole
-- row from the device's copy.
-- Why not simply let the guard take the caller's own target from any save: a stale copy on another
-- device of the same account (or a prod 1.3.0 / 1.4.1 app) sends the OLD goal with its next tick, so
-- the link would be undone silently. So normal saves stay exactly as they are, and only a new,
-- explicit call can change a target:
-- * new public.ascend_pact_link_side(p_challenge_id uuid, p_target text) -> jsonb: the caller's OWN
--   goal text on a running pact (member of the pair, status active, the caller's own last day not
--   over; before day 1 is fine), 1-80 characters after trimming. It marks its transaction
--   (ascend.pact_link = the pact id), updates only that column, clears the mark, and answers like
--   save_shared_challenge_atomic ({success, challenge, today}).
-- * shared_challenges_guard: one new branch. With the mark for this pact, the caller's own target
--   takes the sent value; the partner's target, both categories, title, target_habit_name,
--   start_date, duration, created_at and the done dates (own today only, as before) stay as stored,
--   and finished pacts stay frozen (NEW := OLD runs first). Without the mark nothing changes.
--   The mark is not a security boundary: even forged it could only change the caller's own goal on
--   a running pact. It separates "relink" from "stale copy in a tick".
-- * No notice: a link change ticks nothing, so shared_challenges_notify sends nothing.
-- Prod-compatible (shared DB): no existing signature changes; old apps never call the new function
-- and their saves behave exactly as today. Run BEFORE the studio test (the new app calls the RPC).
-- Rollback: re-run the live guard body saved in work/gap-pact/live-shared_challenges_guard.sql and
-- DROP FUNCTION public.ascend_pact_link_side(uuid, text).

BEGIN;

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
  v_link     text;
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

  -- What the caller sent for their own goal text, read before the freeze below (used only by a
  -- link call from ascend_pact_link_side; every other save keeps both targets as stored).
  v_link := CASE WHEN v_is_user1 THEN NEW.user1_target ELSE NEW.user2_target END;

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

  -- Link later: only ascend_pact_link_side marks its transaction with this pact's id. Then the
  -- caller's OWN goal text (the name their side links to a habit / bad habit by) takes the sent
  -- value; the partner's side, both categories and everything above stay as stored. A normal save
  -- (any app version, a stale copy from another device) carries no mark, so its targets are ignored.
  IF coalesce(current_setting('ascend.pact_link', true), '') = OLD.id::text THEN
    v_link := regexp_replace(btrim(coalesce(v_link, '')), '\s+', ' ', 'g');
    IF v_link <> '' AND char_length(v_link) <= 80 THEN
      IF v_is_user1 THEN
        NEW.user1_target := v_link;
      ELSE
        NEW.user2_target := v_link;
      END IF;
    END IF;
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

CREATE OR REPLACE FUNCTION public.ascend_pact_link_side(p_challenge_id uuid, p_target text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_row      public.shared_challenges;
  v_is_user1 boolean;
  v_target   text;
  v_tz       text;
  v_own_day  integer;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sign in to change a challenge.');
  END IF;

  -- The same name rule as the app: trimmed, inner spaces collapsed, at most 80 characters.
  v_target := regexp_replace(btrim(coalesce(p_target, '')), '\s+', ' ', 'g');
  IF v_target = '' OR char_length(v_target) > 80 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Write a name of 1 to 80 characters.');
  END IF;

  SELECT sc.* INTO v_row FROM public.shared_challenges sc WHERE sc.id = p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'This challenge no longer exists.');
  END IF;

  SELECT (p.user1_id = v_uid) INTO v_is_user1
  FROM public.partnerships p
  WHERE p.id = v_row.partnership_id AND (p.user1_id = v_uid OR p.user2_id = v_uid);
  IF v_is_user1 IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: You are not a member of this partnership.');
  END IF;

  -- Running pacts only, and only while the caller still has days left (before day 1 is fine).
  v_tz := coalesce(public.ascend_own_timezone(v_uid), 'Asia/Karachi');
  v_own_day := (now() AT TIME ZONE v_tz)::date
               - coalesce(v_row.start_date, (v_row.created_at AT TIME ZONE v_tz)::date) + 1;
  IF coalesce(v_row.status, 'active') <> 'active' OR v_own_day > coalesce(v_row.duration_days, 7) THEN
    RETURN jsonb_build_object('success', false, 'error', 'This challenge has ended, so it can no longer change.');
  END IF;

  -- The guard takes the caller's own target only under this mark (local to this transaction).
  PERFORM set_config('ascend.pact_link', v_row.id::text, true);
  IF v_is_user1 THEN
    UPDATE public.shared_challenges SET user1_target = v_target WHERE id = v_row.id RETURNING * INTO v_row;
  ELSE
    UPDATE public.shared_challenges SET user2_target = v_target WHERE id = v_row.id RETURNING * INTO v_row;
  END IF;
  PERFORM set_config('ascend.pact_link', '', true);

  RETURN jsonb_build_object(
    'success', true,
    'challenge_id', v_row.id,
    'challenge', to_jsonb(v_row),
    'today', to_char((now() AT TIME ZONE v_tz)::date, 'YYYY-MM-DD')
  );
END;
$function$;

-- The guard keeps its ACL (trigger only); the link call is for signed-in members.
REVOKE ALL ON FUNCTION public.shared_challenges_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shared_challenges_guard() TO service_role;
REVOKE ALL ON FUNCTION public.ascend_pact_link_side(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ascend_pact_link_side(uuid, text) TO authenticated, service_role;

COMMIT;
