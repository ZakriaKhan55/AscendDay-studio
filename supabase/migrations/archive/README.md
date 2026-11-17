# Archived SQL (historical, not migrations)

These files are kept for history only. They are **not** migrations and must **not** be run.
The Supabase CLI skips sub-folders of `supabase/migrations`, so nothing here is applied by
`supabase db push` / `db reset`. They also had no `<timestamp>_name.sql` version, so the CLI
never picked them up before the move either.

| File | What it was | Live state (checked 2026-11-17) |
|---|---|---|
| `phase_c_d_scaling.sql` | Early (Aug 2026) plan review cadence + `process_daily_reminder_notifications`, run by hand in the SQL editor. | The function is gone (dropped by `20261017080000_web_push.sql`; the live reminder is `ascend_send_daily_reminder`). Its columns `review_cadence` / `next_review_due_at` on `improvement_plans` and `user_plan_follows` are still live. |
| `season_reset.sql` | Early `execute_season_reset` RPC + `profiles.season_history` column. | The function is not live (seasons are server-side since `20261015270000` / `20261016140000`). The `profiles.season_history` column is still live. |

Note for a fresh database built only from `supabase/migrations`: these files were never part of
that path, so the columns above come only from the live database, not from any migration.
Moved here for CodeRabbit CR-10-18 (2026-11-17).
