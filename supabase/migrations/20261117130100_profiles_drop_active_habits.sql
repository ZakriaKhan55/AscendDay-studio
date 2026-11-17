-- 12C: drop profiles.active_habits. The app stopped reading and writing it on 2026-10-23 (a283c5b);
-- after the 2026-11-01 launch wipe 0 of 11 profiles hold a non-empty value (checked 2026-11-17).
-- No function (any schema), view, policy, trigger, index, publication or cron job uses it. Its size
-- check (profiles_active_habits_size) is dropped with the column.
-- Rollback (data was empty): ALTER TABLE public.profiles ADD COLUMN active_habits jsonb DEFAULT '[]'::jsonb;
--   then re-add profiles_active_habits_size CHECK (octet_length(active_habits::text) <= 262144).

ALTER TABLE public.profiles DROP COLUMN IF EXISTS active_habits;
