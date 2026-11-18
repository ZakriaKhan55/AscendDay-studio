import type { PointsEntry } from '@/types';

/**
 * Mirror of ascend_award_gained_at (supabase/migrations/20261118133000_award_gained_at.sql): the
 * gainedAt of a recomputed one-row-per-day award (workout, skill, reading, focus, time tracker).
 * Now when the day's live row (kept) exists and the new amount is higher; else the kept row's own
 * gainedAt; else none (a new row, whose time is already its first earning). The row's timestamp never
 * moves; gainedAt is read only by the league tie-break ("reached first"). Change both sides together.
 */
export function awardGainedAt(kept: PointsEntry | null | undefined, amount: number, nowMs: number): string | undefined {
  if (!kept) return undefined;
  if (typeof kept.amount === 'number' && Number.isFinite(kept.amount) && amount > kept.amount) {
    return new Date(nowMs).toISOString();
  }
  return typeof kept.gainedAt === 'string' ? kept.gainedAt : undefined;
}

/** The entry fields for a gainedAt value: none when there is none (the server leaves the key out). */
export const gainedAtField = (gainedAt: string | undefined): { gainedAt?: string } => (gainedAt ? { gainedAt } : {});
