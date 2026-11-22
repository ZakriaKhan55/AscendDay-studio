-- "Set progress by hand" for goals and projects (2026-11-22).
-- Order: BEFORE the studio test of 1.6.0 (the new client sends manual_mode for both tables; a
-- missing column makes PostgREST refuse the whole upsert). Prod-safe: additive, default false, old
-- clients never send it, so their upserts leave the value as it is.
-- Report: knowledge/mode-a-manual-progress-2026-11-22.md (Goals addendum G6).
-- Catalog check 2026-11-22: no column-level grants (table-level authenticated=arw covers it), realtime
-- publication has no column list, no function / view / policy / cron job reads these tables'
-- columns (ascend_purge_soft_deleted_rows is column-agnostic). Postgres 17: ADD COLUMN ... NOT NULL
-- DEFAULT false is metadata-only (no table rewrite).
-- Rollback (only before the prod push): DROP COLUMN manual_mode on both tables.

BEGIN;

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS manual_mode boolean NOT NULL DEFAULT false;
ALTER TABLE public.goals    ADD COLUMN IF NOT EXISTS manual_mode boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.projects.manual_mode IS 'User sets progress by hand: linked tasks never change progress or status (app rule, projectProgress.ts).';
COMMENT ON COLUMN public.goals.manual_mode    IS 'User sets progress by hand: linked projects never change progress or status (app rule, projectProgress.ts).';

COMMIT;
