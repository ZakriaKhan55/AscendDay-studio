-- Indexes for 8 foreign keys the Supabase performance advisor lists as unindexed (2026-11-21).
-- Order: AFTER 20261121120000; independent of the app (BEFORE/AFTER both fine).
-- Report: knowledge/mode-a-supabase-advisors-2026-11-21.md.
-- Catalog check 2026-11-21: none of these columns leads an existing index (partner_invites and
-- partnerships only have LEAST/GREATEST expression indexes, notifications leads with recipient_id),
-- so all 8 are added. Plain btree; tables are tiny, so a normal (non-concurrent) build is fine.

CREATE INDEX IF NOT EXISTS improvement_plans_creator_id_idx       ON public.improvement_plans (creator_id);
CREATE INDEX IF NOT EXISTS notifications_actor_id_idx             ON public.notifications (actor_id);
CREATE INDEX IF NOT EXISTS partner_invites_from_user_id_idx       ON public.partner_invites (from_user_id);
CREATE INDEX IF NOT EXISTS partner_invites_to_user_id_idx         ON public.partner_invites (to_user_id);
CREATE INDEX IF NOT EXISTS partnerships_user1_id_idx              ON public.partnerships (user1_id);
CREATE INDEX IF NOT EXISTS partnerships_user2_id_idx              ON public.partnerships (user2_id);
CREATE INDEX IF NOT EXISTS user_plan_follows_original_plan_id_idx ON public.user_plan_follows (original_plan_id);
CREATE INDEX IF NOT EXISTS user_plan_follows_user_id_idx          ON public.user_plan_follows (user_id);
