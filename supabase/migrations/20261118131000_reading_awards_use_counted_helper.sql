-- Reading: one SQL copy of the same-place (two devices) page rule (2026-11-18, item reading-range-dup).
-- Order: any time (no number changes); apply it after 20261118110000 (live). Not applied.
--
-- The rule "a log with a start place (data.fromAmount) counts only the part of its range that earlier
-- logs of the same book, unit and read (data.readStartedAt) did not already cover that day; a unit
-- switch starts the book's ranges over" had two copies: the loop inside the page award
-- (20261117173000_reading_awards_dedupe_ranges.sql) and ascend_reading_log_counted
-- (20261118110000_member_card_reading_dedupe.sql, used by the member card). Now the award takes each
-- log's counted amount from ascend_reading_log_counted, so the rule lives in one place. The app has
-- one copy too (coverReadingDayEvents in src/lib/points/readingAwards.ts, shared by
-- computeReadingDayAward and countedReadingAmounts).
--
-- 1. ascend_reading_log_counted: the live body (read 2026-11-18) with one change: a Finish log is
--    recognised as the award does it, (data->>'finish') = 'true', so a string "true" is a Finish log
--    too (it was a jsonb true only). A Finish log covers nothing. Live: every Finish log is a jsonb true
--    (2 of 59, 2026-11-18), so no live number changes. Same signature, grants re-stated as live.
-- 2. ascend_recompute_reading_awards (4-arg): the live body (read 2026-11-18, = 20261117173000) with the
--    range loop replaced by the helper's amount for that day (chapters: whole tenths, 2 pages each, as
--    before). Everything else is unchanged: which logs count (books still in the library, not Finish),
--    time order, unit switches (owed/best), cap 10, p_floor, advisory lock, row time, retired rows.
--    The helper is STABLE and reads the same snapshot as the award's query (it sees the log that fired
--    the trigger); it runs once per recompute. Same signature, grants re-stated as live.
--
-- No live row changes when this is applied: no live log has fromAmount (0 of 59, 2026-11-18), and a
-- recompute only runs on a new write. Proof: work/rrd/pglite-test.mjs runs the live bodies and this file
-- on the same days (random days with ranges, switches, chapters, Finish and removed books, the shared
-- fixtures, and a copy of every live reading day) and compares the award rows byte for byte.
-- Rollback: work/snapshots/reading-range-dup-2026-11-18/*.live.sql.

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
             -- The place the log started from (app after 1.4.1); NULL = counted in full. A Finish log
             -- (the page award's test: data->>'finish' = 'true') never covers.
             CASE WHEN jsonb_typeof(l.data->'fromAmount') = 'number' AND (l.data->>'fromAmount')::numeric >= 0
                       AND (l.data->>'finish') IS DISTINCT FROM 'true'
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

CREATE OR REPLACE FUNCTION public.ascend_recompute_reading_awards(p_user uuid, p_day date, p_tz text, p_floor boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_key       text        := to_char(p_day, 'YYYY-MM-DD');
  v_day_start timestamptz := p_day::timestamp AT TIME ZONE p_tz;
  v_day_end   timestamptz := (p_day + 1)::timestamp AT TIME ZONE p_tz;
  v_pages     numeric     := 0;
  v_count     int         := 0;
  v_used      int;
  v_first     timestamptz;
  v_kept      text;
  v_kept_amt  numeric;
  v_at        timestamptz;
  v_id        text        := 'reading_award_' || to_char(p_day, 'YYYY-MM-DD');
  v_item      record;
  v_books     jsonb       := '{}'::jsonb; -- per book: running total "t", best "b", owed "d", in pages
  v_total     numeric;
  v_owed      numeric;
  v_best      numeric;
  v_new_best  numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('reading_awards:' || p_user::text || ':' || v_key));

  FOR v_item IN
    SELECT ev.kind, ev.book_id, ev.pages, ev.logged_at
    FROM (
      SELECT 0 AS kind,
             b.id AS book_id,
             l.id AS ord_id,
             -- What the log counts (ascend_reading_log_counted: the same-place rule, in the log's unit),
             -- in pages: a chapter log in whole tenths of a chapter, 2 pages each.
             CASE WHEN (CASE WHEN lower(l.data->>'unit') IN ('pages', 'chapters') THEN lower(l.data->>'unit')
                             ELSE lower(b.data->>'unit') END) = 'chapters'
                  THEN round(coalesce(c.amount, public.ascend_reading_log_pages(l.data)) * 10) * 2
                  ELSE coalesce(c.amount, public.ascend_reading_log_pages(l.data)) END AS pages,
             public.ascend_instant(l.data->>'createdAt') AS logged_at
      FROM public.reading_logs l
      JOIN public.reading_books b
        ON b.user_id = l.user_id AND b.id = l.data->>'bookId' AND b.deleted_at IS NULL
      LEFT JOIN public.ascend_reading_log_counted(p_user, v_key, v_key) c ON c.log_id = l.id
      WHERE l.user_id = p_user
        AND l.deleted_at IS NULL
        AND l.data->>'date' = v_key
        AND (l.data->>'finish') IS DISTINCT FROM 'true'
      UNION ALL
      SELECT 1,
             b.id,
             b.id || '#' || s.ord,
             (s.e->>'pagesAfter')::numeric - (s.e->>'pagesBefore')::numeric,
             public.ascend_instant(s.e->>'at')
      FROM public.reading_books b
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(b.data->'unitSwitches') = 'array' THEN b.data->'unitSwitches' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS s(e, ord)
      WHERE b.user_id = p_user
        AND b.deleted_at IS NULL
        AND jsonb_typeof(s.e) = 'object'
        AND s.e->>'date' = v_key
        AND jsonb_typeof(s.e->'pagesBefore') = 'number'
        AND jsonb_typeof(s.e->'pagesAfter') = 'number'
    ) ev
    ORDER BY ev.logged_at NULLS LAST, ev.kind, ev.ord_id COLLATE "C"
  LOOP
    v_total := coalesce((v_books->v_item.book_id->>'t')::numeric, 0);
    v_best := coalesce((v_books->v_item.book_id->>'b')::numeric, 0);
    v_owed := coalesce((v_books->v_item.book_id->>'d')::numeric, 0);
    IF v_item.kind = 0 OR v_item.pages < 0 THEN
      v_total := v_total + v_item.pages;
    ELSE
      v_total := v_total + least(v_item.pages, v_owed); -- a raising switch only gives back what is owed
    END IF;
    IF v_item.kind = 1 THEN
      v_owed := greatest(v_owed - v_item.pages, 0);
    END IF;
    v_new_best := greatest(v_best, v_total);
    v_pages := v_pages + (v_new_best - v_best);
    v_books := v_books || jsonb_build_object(v_item.book_id, jsonb_build_object('t', v_total, 'b', v_new_best, 'd', v_owed));
    IF v_item.kind = 0 THEN
      v_count := v_count + 1;
      IF v_first IS NULL AND least(floor(v_pages / 2), 10) > 0 THEN
        v_first := coalesce(v_item.logged_at, now());
      END IF;
    END IF;
  END LOOP;

  v_used := least(floor(v_pages / 2), 10)::int;

  SELECT pe.data->>'timestamp',
         CASE WHEN jsonb_typeof(pe.data->'amount') = 'number' THEN (pe.data->>'amount')::numeric END
  INTO v_kept, v_kept_amt
  FROM public.point_entries pe
  WHERE pe.user_id = p_user AND pe.id = v_id AND pe.deleted_at IS NULL;

  IF p_floor AND v_used <= coalesce(v_kept_amt, 0) THEN
    RETURN; -- an earlier day never drops
  END IF;

  IF v_used > 0 THEN
    v_at := least(greatest(v_first, v_day_start), now(), v_day_end - interval '1 millisecond');
    INSERT INTO public.point_entries AS pe (user_id, id, data, created_at, updated_at)
    VALUES (p_user, v_id, jsonb_build_object(
      'id', v_id,
      'amount', v_used,
      'reason', 'Pages logged (' || v_count || ')',
      'source', 'reading',
      'timestamp', coalesce(v_kept, to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      'metadata', jsonb_build_object('date', v_key, 'logs', v_count)
    ), now(), now())
    ON CONFLICT (user_id, id) DO UPDATE
      SET data = EXCLUDED.data, deleted_at = NULL, updated_at = greatest(now(), pe.updated_at)
      WHERE pe.data IS DISTINCT FROM EXCLUDED.data OR pe.deleted_at IS NOT NULL;
  ELSE
    UPDATE public.point_entries pe
    SET deleted_at = now(), updated_at = greatest(now(), pe.updated_at)
    WHERE pe.user_id = p_user AND pe.id = v_id AND pe.deleted_at IS NULL;
  END IF;

  IF p_floor THEN
    RETURN; -- never takes anything away from an earlier day
  END IF;

  UPDATE public.point_entries pe
  SET deleted_at = now(), updated_at = greatest(now(), pe.updated_at)
  WHERE pe.user_id = p_user
    AND pe.deleted_at IS NULL
    AND pe.id NOT LIKE 'reading\_award\_%'
    AND pe.id NOT LIKE 'reading\_bonus\_%'
    AND pe.data->>'source' IN ('reading', 'reading_bonus')
    AND jsonb_typeof(pe.data->'amount') = 'number'
    AND (pe.data->>'amount')::numeric > 0
    AND public.ascend_instant(pe.data->>'timestamp') >= v_day_start
    AND public.ascend_instant(pe.data->>'timestamp') < v_day_end;
END;
$function$;

REVOKE ALL ON FUNCTION public.ascend_recompute_reading_awards(uuid, date, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ascend_recompute_reading_awards(uuid, date, text, boolean) TO service_role;
