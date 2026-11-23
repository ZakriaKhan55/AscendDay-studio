import type { AppState, SharedChallenge } from '@/types';
import { mergeSharedChallenge, reconcileSharedChallengeLifecycle } from './pactLifecycle';

/**
 * A realtime partner change the store applies straight from the event (no refetch needed for it):
 * an invite, partnership or pact deleted, or a pact row inserted or updated. Invite and partnership
 * INSERT/UPDATE carry no transform here; they only trigger the partner refetch.
 */
export type PartnerEvent =
  | { kind: 'inviteDeleted'; id: string }
  | { kind: 'partnershipDeleted'; id: string }
  | { kind: 'pactDeleted'; id: string }
  | { kind: 'pactUpserted'; challenge: SharedChallenge };

/** Tombstones kept in AppState.deletedEntityIds (newest last). */
const TOMBSTONE_LIMIT = 500;
const withTombstone = (state: AppState, id: string): string[] => [...(state.deletedEntityIds || []), id].slice(-TOMBSTONE_LIMIT);

/** The pact a shared_challenges realtime row (INSERT/UPDATE `payload.new`) describes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sharedChallengeFromRow(row: any): SharedChallenge {
  const u1DoneDates = Array.isArray(row.user1_done_dates) && row.user1_done_dates.length
    ? row.user1_done_dates
    : (row.user1_done_date ? [row.user1_done_date] : []);
  const u2DoneDates = Array.isArray(row.user2_done_dates) && row.user2_done_dates.length
    ? row.user2_done_dates
    : (row.user2_done_date ? [row.user2_done_date] : []);

  return reconcileSharedChallengeLifecycle({
    id: row.id,
    partnershipId: row.partnership_id,
    title: row.title,
    targetHabitName: row.target_habit_name,
    durationDays: row.duration_days,
    jointStreak: row.joint_streak,
    totalJointDaysCompleted: row.total_joint_days_completed ?? 0,
    user1Category: row.user1_category || 'habit',
    user1Target: row.user1_target || row.target_habit_name,
    user2Category: row.user2_category || 'habit',
    user2Target: row.user2_target || row.target_habit_name,
    user1DoneDate: row.user1_done_date || undefined,
    user2DoneDate: row.user2_done_date || undefined,
    user1DoneDates: u1DoneDates,
    user2DoneDates: u2DoneDates,
    status: row.status as 'active' | 'completed' | 'expired',
    createdAt: row.created_at,
    ...(typeof row.start_date === 'string' && row.start_date ? { startDate: row.start_date } : {}),
  });
}

/**
 * The state after one realtime partner event, as the live handler applies it. Pure: the same
 * function runs for the event on screen and when an account load replays it (see PartnerEventLog).
 * A pact of a deleted pact or partnership (tombstoned) is ignored: the same state object comes back.
 */
export function applyPartnerEvent(state: AppState, event: PartnerEvent): AppState {
  switch (event.kind) {
    case 'inviteDeleted':
      return {
        ...state,
        partnerInvites: (state.partnerInvites || []).filter((i) => i.id !== event.id),
        deletedEntityIds: withTombstone(state, event.id),
      };
    case 'partnershipDeleted': {
      const remainingPartnerships = (state.partnerships || []).filter((p) => p.id !== event.id);
      return {
        ...state,
        partnerships: remainingPartnerships,
        partnership: remainingPartnerships[0] || null,
        sharedChallenges: (state.sharedChallenges || []).filter((c) => c.partnershipId !== event.id),
        deletedEntityIds: withTombstone(state, event.id),
      };
    }
    case 'pactDeleted':
      return {
        ...state,
        sharedChallenges: (state.sharedChallenges || []).filter((c) => c.id !== event.id),
        deletedEntityIds: withTombstone(state, event.id),
      };
    case 'pactUpserted': {
      const incoming = event.challenge;
      const tombstones = state.deletedEntityIds || [];
      if (tombstones.includes(incoming.id) || tombstones.includes(incoming.partnershipId)) return state;
      const exists = (state.sharedChallenges || []).some((c) => c.id === incoming.id);
      return {
        ...state,
        sharedChallenges: exists
          ? state.sharedChallenges.map((c) => (c.id === incoming.id ? mergeSharedChallenge(c, incoming) : c))
          : [incoming, ...(state.sharedChallenges || [])],
      };
    }
  }
}

/** The pact an event writes to, if it updates or inserts one. */
export const upsertedPactId = (event: PartnerEvent): string | undefined =>
  event.kind === 'pactUpserted' ? event.challenge.id : undefined;

export interface LoggedPartnerEvent {
  seq: number;
  event: PartnerEvent;
}

/**
 * The realtime partner events applied on screen, for one account, numbered by the partner read
 * counter (`partnerReadSeq` in the store: a counter, not a clock). An account load whose partner read
 * started at seq S replays every event with seq > S, in seq order, onto its own partner data, so the
 * screen never goes back to the read's older copy.
 *
 * Why the replay ends at the latest state (no updated_at/version on the partner tables, so ordering
 * is all we have): realtime delivers one channel's changes in commit order, and each event is
 * numbered when it arrives, so seq order is commit order. Every change committed after the read's
 * snapshot arrives after the read started, so its event has seq > S and is replayed. An event with
 * seq > S whose change the read already saw re-applies a value the read holds, or an older one only
 * when a later change superseded it; that later change arrived later still and is replayed after it.
 * Replaying the suffix in order therefore ends where the screen is: read + every newer change.
 *
 * Bounded: past `limit` entries the oldest are dropped and `since` reports a gap (null) for a read
 * older than one of them, so the caller falls back to a full partner refetch.
 */
export class PartnerEventLog {
  private userId: string | null = null;
  private entries: LoggedPartnerEvent[] = [];
  /** Highest seq dropped by the bound (0: none). */
  private droppedSeq = 0;

  constructor(private readonly limit = 100) {}

  /** Records an event applied on screen for `userId`; an event of another account starts afresh. */
  record(userId: string, seq: number, event: PartnerEvent): void {
    if (this.userId !== userId) this.clear();
    this.userId = userId;
    this.entries.push({ seq, event });
    while (this.entries.length > this.limit) {
      this.droppedSeq = Math.max(this.droppedSeq, this.entries.shift()!.seq);
    }
  }

  /** `userId`'s events with seq > `seq`, oldest first; null when one of them was dropped. */
  since(userId: string, seq: number): LoggedPartnerEvent[] | null {
    if (this.userId !== userId) return [];
    if (this.droppedSeq > seq) return null;
    return this.entries.filter((e) => e.seq > seq);
  }

  /** Drops the events a read (or load) that started at `seq` and is now on screen already holds. */
  prune(seq: number): void {
    this.entries = this.entries.filter((e) => e.seq > seq);
    if (this.droppedSeq <= seq) this.droppedSeq = 0;
  }

  /** Sign-out or another account: nothing recorded belongs to the next load. */
  clear(): void {
    this.userId = null;
    this.entries = [];
    this.droppedSeq = 0;
  }

  get size(): number {
    return this.entries.length;
  }
}
