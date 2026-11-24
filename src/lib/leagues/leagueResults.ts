import type { LeagueArchive, LeagueCompetitor, LeagueResultsSeen, LeagueType } from '@/types';
import {
  compareArchivesNewestFirst,
  getArchivePeriodEnd,
  getArchivePeriodLabel,
  getArchivePeriodStart,
  getLeaguePeriodStart,
} from './leagues';

/*
 * League results memory (settings doc `leagueResultsSeen`): per league type, the period id of the
 * newest result already shown. A result shows once, as soon as the server's first archive for an
 * ended period is in (provisional is fine); a later recompute of that archive never shows it again.
 * Only the newest unseen result per type shows; older missed ones stay in the Leagues history.
 * It shows only while it is the period that just ended (it ends where the running period starts):
 * someone back after a longer break gets no stale card; it is marked seen silently instead.
 * Missing memory (accounts from before this, new accounts) is filled with the newest existing
 * results silently, so no backlog pops up.
 */

/** Order the cards show in: week, month, then the season as the finale. */
export const LEAGUE_RESULT_ORDER: readonly LeagueType[] = ['weekly', 'monthly', 'ninetyDay'];

const PERIOD_ID = /^(W:\d{4}-W\d{1,2}|M:\d{4}-\d{1,2})(@S\d+)?$|^S:\d+$/;
const ID_PREFIX: Record<LeagueType, string> = { weekly: 'W:', monthly: 'M:', ninetyDay: 'S:' };

function isPeriodId(id: unknown, type: LeagueType): id is string {
  return typeof id === 'string' && PERIOD_ID.test(id) && id.startsWith(ID_PREFIX[type]);
}

/** 'W:2026-W48@S3' -> 'W:2026-W48'. */
function basePeriod(id: string | undefined): string {
  return (id ?? '').split('@')[0];
}

function isValid(memory: LeagueResultsSeen | null | undefined): memory is LeagueResultsSeen {
  return !!memory && typeof memory === 'object' && !Array.isArray(memory);
}

/** The stored id for a type, or null when it is missing or not a period id of that type. */
function seenId(memory: LeagueResultsSeen, type: LeagueType): string | null {
  const id = memory[type];
  return isPeriodId(id, type) ? id : null;
}

/** Positive when period `a` is newer than period `b` (ends later; same end: starts later). */
function comparePeriods(a: string, b: string): number {
  const pa = { id: a } as LeagueArchive;
  const pb = { id: b } as LeagueArchive;
  return getArchivePeriodEnd(pa) - getArchivePeriodEnd(pb) || getArchivePeriodStart(pa) - getArchivePeriodStart(pb);
}

function newerId(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return comparePeriods(b, a) > 0 ? b : a;
}

/** Two devices converge: per type the newer period wins, so a result shown on one never shows on another. */
export function mergeLeagueResultsSeen(
  base: LeagueResultsSeen | null | undefined,
  incoming: LeagueResultsSeen | null | undefined
): LeagueResultsSeen | null {
  if (!isValid(base)) return isValid(incoming) ? incoming : null;
  if (!isValid(incoming)) return base;
  const merged = {} as LeagueResultsSeen;
  for (const type of LEAGUE_RESULT_ORDER) merged[type] = newerId(seenId(base, type), seenId(incoming, type));
  return merged;
}

/** Server archives of a type whose period has ended by `nowMs`, newest first. */
function endedServerArchives(archives: readonly LeagueArchive[], type: LeagueType, nowMs: number): LeagueArchive[] {
  return archives
    .filter((a) => a.source === 'server' && a.type === type && isPeriodId(a.id, type) && getArchivePeriodEnd(a) <= nowMs)
    .sort(compareArchivesNewestFirst);
}

/** How big the moment is: 1st the full show, 2nd/3rd a medal, 4th+ or alone on the board calm. */
export type LeagueResultTier = 'first' | 'podium' | 'calm';

export interface LeagueResultPodiumEntry {
  place: number;
  name: string;
  avatar: string;
  points: number;
  isUser: boolean;
}

export interface LeagueResultCard {
  type: LeagueType;
  periodId: string;
  periodLabel: string;
  seasonNumber: number | null;
  /** The archive's own userRank (ties are already broken by the server). */
  place: number;
  /** Members on the board (with points this period). */
  of: number;
  points: number;
  alone: boolean;
  tier: LeagueResultTier;
  /** Top three in the archive's order. */
  podium: LeagueResultPodiumEntry[];
  /** Against the previous archived period of the same type, when there is one. */
  delta: { places: number; points: number } | null;
}

function podiumOf(competitors: readonly LeagueCompetitor[]): LeagueResultPodiumEntry[] {
  return competitors.slice(0, 3).map((c, i) => ({
    place: i + 1,
    name: c.name,
    avatar: c.avatar || '🧑',
    points: c.points,
    isUser: c.isUser === true,
  }));
}

export function buildLeagueResultCard(archive: LeagueArchive, previous: LeagueArchive | null): LeagueResultCard {
  const of = Math.max(archive.competitors.length, archive.userRank, 1);
  const place = Number.isInteger(archive.userRank) && archive.userRank >= 1 ? archive.userRank : of;
  const alone = of <= 1;
  const tier: LeagueResultTier = alone ? 'calm' : place === 1 ? 'first' : place <= 3 ? 'podium' : 'calm';
  const seasonNumber = archive.type === 'ninetyDay' ? parseInt((archive.id ?? '').slice(2), 10) : archive.seasonNumber ?? null;
  return {
    type: archive.type,
    periodId: archive.id ?? '',
    periodLabel: getArchivePeriodLabel(archive),
    seasonNumber: Number.isFinite(seasonNumber) ? (seasonNumber as number) : null,
    place,
    of,
    points: archive.userPoints,
    alone,
    tier,
    podium: podiumOf(archive.competitors),
    delta:
      previous && Number.isInteger(previous.userRank) && previous.userRank >= 1
        ? { places: previous.userRank - place, points: archive.userPoints - previous.userPoints }
        : null,
  };
}

export type LeagueResultsDecision =
  | { kind: 'none' }
  /** Store `memory` without showing anything. */
  | { kind: 'baseline'; memory: LeagueResultsSeen }
  /** Show `cards` (week, month, season order), then store `memory`. */
  | { kind: 'celebrate'; cards: LeagueResultCard[]; memory: LeagueResultsSeen };

export function decideLeagueResults(
  stored: LeagueResultsSeen | null | undefined,
  archives: readonly LeagueArchive[],
  nowMs: number
): LeagueResultsDecision {
  const newest = {} as Record<LeagueType, LeagueArchive[]>;
  for (const type of LEAGUE_RESULT_ORDER) newest[type] = endedServerArchives(archives, type, nowMs);

  if (!isValid(stored)) {
    const memory = {} as LeagueResultsSeen;
    for (const type of LEAGUE_RESULT_ORDER) memory[type] = newest[type][0]?.id ?? null;
    return { kind: 'baseline', memory };
  }

  const cards: LeagueResultCard[] = [];
  const memory = {} as LeagueResultsSeen;
  let staleMarked = false;
  for (const type of LEAGUE_RESULT_ORDER) {
    const [latest, ...older] = newest[type];
    // The part of the same week or month on the other side of a season start is not "last week".
    const previous = latest ? older.find((a) => basePeriod(a.id) !== basePeriod(latest.id)) : undefined;
    const seen = seenId(stored, type);
    memory[type] = seen;
    if (!latest?.id || (seen !== null && comparePeriods(latest.id, seen) <= 0)) continue;
    memory[type] = latest.id;
    const justEnded = getArchivePeriodEnd(latest) >= getLeaguePeriodStart(type, new Date(nowMs)).getTime();
    if (justEnded) cards.push(buildLeagueResultCard(latest, previous ?? null));
    else staleMarked = true;
  }
  if (cards.length) return { kind: 'celebrate', cards, memory };
  return staleMarked ? { kind: 'baseline', memory } : { kind: 'none' };
}
