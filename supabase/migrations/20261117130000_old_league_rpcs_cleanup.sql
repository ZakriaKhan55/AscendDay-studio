-- Old league RPC cleanup (League P1 left these for one release; prod has used ascend_league_boards
-- since 10-24).
-- 1. ascend_league_points: no caller in SQL or the app; 0 calls in edge logs since 2026-11-01.
-- 2. ascend_member_profiles: the app only calls it with p_username (profile dialog). A call without
--    a username now returns no rows instead of every member's stats. Same signature, return type,
--    STABLE, SECURITY DEFINER, search_path and grants (CREATE OR REPLACE keeps the ACL; the DEFAULT
--    stays because CREATE OR REPLACE cannot remove it).
-- Rollback: work/snapshots/drop-active-habits-and-old-league-rpcs-2026-11-17/rollback.sql (function parts).

DROP FUNCTION IF EXISTS public.ascend_league_points(timestamptz[], timestamptz[]);

CREATE OR REPLACE FUNCTION public.ascend_member_profiles(p_username text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, uid text, username text, avatar text, total_points integer, season_points numeric, season_id integer, stats jsonb, is_profile_public boolean, season_history jsonb, created_at timestamp with time zone, accept_partner_invites boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_viewer uuid := auth.uid();
  v_viewer_public boolean;
BEGIN
  IF v_viewer IS NULL THEN
    RETURN;
  END IF;
  -- One member by username only (the profile dialog). The no-argument list form (every member's
  -- stats) was only used by clients before League P1; ascend_league_boards replaced it.
  IF p_username IS NULL OR btrim(p_username) = '' THEN
    RETURN;
  END IF;
  SELECT coalesce(pr.is_profile_public, true) INTO v_viewer_public
  FROM public.profiles pr WHERE pr.id = v_viewer;

  RETURN QUERY
  SELECT
    p.id, p.uid::text, p.username, p.avatar, p.total_points, p.season_points,
    p.season_id,
    CASE WHEN d.allowed THEN p.stats END,
    p.is_profile_public,
    CASE WHEN d.allowed THEN p.season_history END,
    p.created_at, p.accept_partner_invites
  FROM public.profiles p
  CROSS JOIN LATERAL (
    SELECT (
      p.id = v_viewer
      OR (coalesce(v_viewer_public, true) AND coalesce(p.is_profile_public, true))
      OR EXISTS (
        SELECT 1 FROM public.partnerships ps
        WHERE (ps.user1_id = v_viewer AND ps.user2_id = p.id)
           OR (ps.user2_id = v_viewer AND ps.user1_id = p.id)
      )
    ) AS allowed
  ) d
  WHERE p_username IS NULL OR lower(p.username) = lower(btrim(p_username));
END;
$function$;
