import { useState } from 'react';
import { ChevronRight, Play } from 'lucide-react';
import { Button, Switch, cx } from '@/components/ui/primitives';
import { RankUpCelebration } from '@/components/ui/RankUpCelebration';
import { LeagueResultsOverlay } from '@/components/ui/LeagueResultsOverlay';
import { buildLeagueResultCard, type LeagueResultCard } from '@/lib/leagues/leagueResults';
import { TierBadge } from '@/components/ui/TierBadge';
import { RankChip } from '@/components/ui/RankChip';
import { LeagueCountdown } from '@/components/ui/LeagueCountdown';
import { CompetitorProfileModal } from '@/components/ui/CompetitorProfileModal';
import { RankNumber, YouTag } from './appCopies';
import { TIERS, getCurrentTier } from '@/lib/leagues/tiers';
import type { MemberDetails } from '@/lib/leagues/useMemberDetails';
import type { LeagueArchive, LeagueCompetitor, LeagueType, MemberCard } from '@/types';
import { Caption, Section } from './shared';

// Every single step plus the jumps Zakria asked for; points shown are the new rank's exact threshold.
const RANK_UP_DEMOS: Array<[number, number]> = [
  ...TIERS.slice(1).map((_, i): [number, number] => [i, i + 1]),
  [0, 4],
  [0, 7],
  [0, 8],
  [6, 8],
];

function RankUpDemo() {
  const [playing, setPlaying] = useState<[number, number] | null>(null);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {RANK_UP_DEMOS.map(([from, to]) => (
          <Button key={`${from}-${to}`} variant="secondary" onClick={() => setPlaying([from, to])} className="justify-start">
            <Play size={14} aria-hidden="true" />
            {TIERS[from].name} → {TIERS[to].name}
            {to - from >= 2 && <span className="text-2xs font-medium text-content-muted">jump</span>}
          </Button>
        ))}
      </div>
      {playing && (
        <RankUpCelebration
          key={playing.join('-')}
          from={playing[0]}
          to={playing[1]}
          seasonPoints={TIERS[playing[1]].minPoints}
          onClose={() => setPlaying(null)}
          forceSound
        />
      )}
    </div>
  );
}

const RESULT_NAMES: Array<[string, string]> = [
  ['sara_k', '🦊'], ['yahya', '🐺'], ['hamza', '🦁'], ['ali_r', '🐯'], ['noor', '🦉'], ['bilal', '🐻'], ['a_member_with_a_really_long_username', '🐢'],
  ['fatima', '🐼'], ['umar', '🐨'], ['ayesha', '🐸'], ['khan', '🐙'], ['zain', '🐬'], ['maryam', '🦋'], ['hassan', '🐝'],
];

/**
 * A fake server archive (as ascend_league_archive_rows writes it): `points` best first, you at
 * `place`. Turned into a card by the real buildLeagueResultCard, with `previous` for the delta line.
 */
function fakeResult(type: LeagueType, id: string, place: number, points: number[], previous?: { place: number; points: number }): LeagueResultCard {
  const archive = (rank: number, pts: number[]): LeagueArchive => ({
    id,
    type,
    periodLabel: '',
    competitors: pts.map((p, i) => {
      const [name, avatar] = i === rank - 1 ? ['zakria', '🦅'] : RESULT_NAMES[i % RESULT_NAMES.length];
      return { id: `c${i}`, name, avatar, points: p, totalPoints: 0, isRealUser: true, ...(i === rank - 1 ? { isUser: true } : {}) };
    }),
    userRank: rank,
    userPoints: pts[rank - 1],
    archivedAt: '2026-11-23T00:15:00.000Z',
    source: 'server',
  });
  const prev = previous ? { ...archive(previous.place, points), userPoints: previous.points } : null;
  return buildLeagueResultCard(archive(place, points), prev);
}

const BOARD_14 = [612, 540, 498, 455, 401, 377, 342, 300, 251, 198, 150, 96, 40, 12];
const WEEK = 'W:2026-W47';
const MONTH = 'M:2026-11';
const SEASON = 'S:1';

const RESULT_DEMOS: Array<{ label: string; note?: string; cards: LeagueResultCard[] }> = [
  { label: 'Week · 1st', cards: [fakeResult('weekly', WEEK, 1, BOARD_14, { place: 3, points: 480 })] },
  { label: 'Week · 2nd', cards: [fakeResult('weekly', WEEK, 2, BOARD_14, { place: 2, points: 560 })] },
  { label: 'Week · 3rd', cards: [fakeResult('weekly', WEEK, 3, BOARD_14)] },
  { label: 'Week · 4th+', note: '#7 of 14', cards: [fakeResult('weekly', WEEK, 7, BOARD_14, { place: 5, points: 410 })] },
  { label: 'Week · alone', note: 'only you scored', cards: [fakeResult('weekly', WEEK, 1, [120])] },
  { label: 'Week · tie', note: '464 vs 464, server put you 2nd', cards: [fakeResult('weekly', WEEK, 2, [464, 464, 461, 300])] },
  { label: 'Season · 1st', note: 'finale', cards: [fakeResult('ninetyDay', SEASON, 1, [5400, 3100, 1840, 900])] },
  { label: 'Season · 5th', cards: [fakeResult('ninetyDay', SEASON, 5, [5400, 3100, 2600, 2000, 1840, 900])] },
  {
    label: '2 cards',
    note: 'week 2nd + month 1st',
    cards: [fakeResult('weekly', WEEK, 2, BOARD_14), fakeResult('monthly', MONTH, 1, [2210, 1980, 1500, 1200, 800])],
  },
  {
    label: '3 cards',
    note: 'week 4th + month 2nd + season 1st',
    cards: [
      fakeResult('weekly', WEEK, 4, BOARD_14, { place: 6, points: 350 }),
      fakeResult('monthly', MONTH, 2, [2210, 1980, 1500, 1200, 800]),
      fakeResult('ninetyDay', SEASON, 1, [5400, 3100, 1840, 900]),
    ],
  },
];

function LeagueResultsDemo() {
  const [playing, setPlaying] = useState<number | null>(null);
  const [reduced, setReduced] = useState(false);
  const [forceSound, setForceSound] = useState(true);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <span className="flex items-center gap-2 text-sm text-content-secondary">
          <Switch checked={reduced} onChange={() => setReduced((v) => !v)} label="Reduced motion" />
          Reduced motion
        </span>
        <span className="flex items-center gap-2 text-sm text-content-secondary">
          <Switch checked={forceSound} onChange={() => setForceSound((v) => !v)} label="Always play sound" />
          Always play sound (off: follow my tick feedback choice, as in the app)
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {RESULT_DEMOS.map((demo, i) => (
          <Button key={demo.label} variant="secondary" onClick={() => setPlaying(i)} className="justify-start">
            <Play size={14} aria-hidden="true" />
            {demo.label}
            {demo.note && <span className="text-2xs font-medium text-content-muted">{demo.note}</span>}
          </Button>
        ))}
      </div>
      {playing !== null && (
        <LeagueResultsOverlay
          key={`${playing}-${reduced}`}
          cards={RESULT_DEMOS[playing].cards}
          onClose={() => setPlaying(null)}
          forceSound={forceSound}
          forceReducedMotion={reduced}
        />
      )}
    </div>
  );
}

const TIER_SIZES = ['sm', 'md', 'lg', 'xl'] as const;

function TierBadgesDemo() {
  return (
    <div className="space-y-4">
      {TIER_SIZES.map((size) => (
        <div key={size} className="space-y-1.5">
          <Caption>size=&quot;{size}&quot;{size === 'md' ? ' with showName' : ''}</Caption>
          <div className="flex flex-wrap items-center gap-3">
            {TIERS.map((tier) => (
              <TierBadge key={tier.name} totalPoints={tier.minPoints} size={size} showName={size === 'md'} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function RankChipDemo() {
  const mid = Math.round((TIERS[3].minPoints + TIERS[4].minPoints) / 2);
  const top = TIERS[TIERS.length - 1].minPoints + 1234;
  return (
    <div className="flex flex-wrap items-start gap-6">
      {[
        { label: 'Start (0)', points: 0 },
        { label: `Mid-rank (${mid})`, points: mid },
        { label: `Top rank (${top})`, points: top },
      ].map((c) => (
        <div key={c.label} className="w-60 space-y-1.5">
          <Caption>{c.label}</Caption>
          <div className="rounded-xl border border-overlay-subtle bg-bg-800 p-2">
            <RankChip seasonPoints={c.points} />
          </div>
        </div>
      ))}
    </div>
  );
}

const BOARD: Array<LeagueCompetitor & { season: number }> = [
  { id: 'c1', name: 'sara_k', avatar: '🦊', points: 412, totalPoints: 5400, season: 5400 },
  { id: 'c2', name: 'yahya', avatar: '🐺', points: 388, totalPoints: 3100, season: 3100 },
  { id: 'c3', name: 'zakria', avatar: '🦅', points: 301, totalPoints: 1840, season: 1840, isUser: true },
  { id: 'c4', name: 'a_member_with_a_really_long_username', avatar: '🐢', points: 12, totalPoints: 90, season: 90 },
  { id: 'c5', name: 'newcomer', avatar: '🌱', points: 0, totalPoints: 0, season: 0 },
];

/**
 * The Leagues board row. Its markup is inline in views/Leagues.tsx (no component of its own), so this
 * is a copy of that markup around the real TierBadge and copies of RankNumber and YouTag (appCopies.tsx): keep it in step.
 */
function LeagueRowsDemo() {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="min-w-0 space-y-1.5">
        <Caption>Board row (Weekly): a place, You, tier, points; 0 points has no place (–)</Caption>
        <ol className="card divide-y divide-overlay-subtle overflow-hidden p-0">
          {BOARD.map((c, idx) => {
            const rank = Math.round(c.points) > 0 ? idx + 1 : null;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  aria-label={`${c.name}${c.isUser ? ', you' : ''}, ${getCurrentTier(c.season).name}`}
                  className={cx(
                    'group flex w-full items-center gap-2.5 px-3 py-3 text-left transition-colors sm:gap-4 sm:px-5',
                    c.isUser ? 'bg-overlay-subtle hover:bg-overlay-default' : 'hover:bg-overlay-subtle'
                  )}
                >
                  <RankNumber rank={rank} />
                  <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-overlay-subtle text-base sm:h-10 sm:w-10 sm:text-lg">
                    {c.avatar}
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="item-name truncate text-sm !text-content-secondary">{c.name}</span>
                    {c.isUser && <YouTag />}
                  </span>
                  <span aria-hidden="true" className="shrink-0">
                    <TierBadge totalPoints={c.season} size="sm" showName={false} />
                  </span>
                  <span className="min-w-[3.5rem] shrink-0 text-right sm:min-w-[4.5rem]">
                    <span className="figure text-sm text-content-primary">{c.points.toLocaleString()}</span>
                    <span className="ml-1 text-2xs text-content-muted">pts</span>
                  </span>
                  <ChevronRight size={15} aria-hidden="true" className="shrink-0 text-content-muted transition-colors group-hover:text-content-secondary" />
                </button>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="min-w-0 space-y-1.5">
        <Caption>Past standings row (archive dialog, season board shows the tier)</Caption>
        <ol className="card divide-y divide-overlay-subtle overflow-hidden p-0">
          {BOARD.slice(0, 4).map((c, idx) => (
            <li key={c.id} className={cx('flex items-center gap-3 p-3', c.isUser && 'bg-overlay-subtle')}>
              <RankNumber rank={idx + 1} />
              <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-overlay-subtle text-lg">
                {c.avatar}
              </span>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="item-name truncate text-sm !text-content-secondary">{c.name}</span>
                {c.isUser && <YouTag />}
              </span>
              <TierBadge totalPoints={c.season} size="sm" showName={false} />
              <span className="figure shrink-0 text-sm text-content-primary">{c.season.toLocaleString()} pts</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function LeagueCountdownDemo() {
  return (
    <div className="flex flex-wrap gap-6">
      {(
        [
          ['weekly', 'Weekly resets in'],
          ['monthly', 'Monthly resets in'],
          ['ninetyDay', 'Season ends in'],
        ] as const
      ).map(([type, label]) => (
        <div key={type} className="space-y-1">
          <Caption>{label}</Caption>
          <LeagueCountdown type={type} className="font-mono text-sm text-content-primary" />
        </div>
      ))}
    </div>
  );
}

function card(overrides: Partial<MemberCard> = {}): MemberCard {
  return {
    v: 2,
    season: 1,
    asOf: '2026-11-07',
    from: '2026-11-01',
    days: 7,
    active: 6,
    streak: { days: 6, category: 'Habits' },
    today: { habitsDone: 3 },
    seasonStart: '2026-11-01T00:00:00Z',
    seasonEnd: '2027-01-30T00:00:00Z',
    habits: { done: 31, due: 36 },
    exercise: [
      { name: 'Running', unit: 'km', total: 7.5, days: 3, best: 3.2 },
      { name: 'Push-ups', unit: 'reps', total: 240, days: 5, best: 60 },
      { name: 'Yoga', unit: 'mins', total: 95, days: 2, best: 50 },
    ],
    skills: { minutes: 410, days: 5 },
    reading: { days: 5, booksThisSeason: 1, pages: 214 },
    focus: { minutes: 300, sessions: 6 },
    journal: { days: 4 },
    ...overrides,
  } as MemberCard;
}

type MemberDemoId = 'self' | 'public' | 'loading' | 'failed' | 'private' | 'viewer-private' | 'partner' | 'large' | 'no-card';
const MEMBER_DEMOS: Array<{ id: MemberDemoId; label: string }> = [
  { id: 'self', label: 'You' },
  { id: 'public', label: 'Public member' },
  { id: 'loading', label: 'Loading' },
  { id: 'failed', label: 'Failed' },
  { id: 'private', label: 'Private member' },
  { id: 'viewer-private', label: 'You are private' },
  { id: 'partner', label: 'Partner' },
  { id: 'large', label: 'Large numbers' },
  { id: 'no-card', label: 'No card shared' },
];

const READY = (c: MemberCard | undefined): MemberDetails => ({ status: 'ready', card: c, stats: undefined, seasonHistory: [] });

function memberDemo(id: MemberDemoId): { competitor: LeagueCompetitor; seasonPoints: number; details: MemberDetails; viewerIsPublic?: boolean; isPartner?: boolean } {
  const base: LeagueCompetitor = { id: 'm-' + id, name: 'sara_k', avatar: '🦊', points: 412, totalPoints: 5400, isProfilePublic: true, isRealUser: true };
  switch (id) {
    case 'self':
      return { competitor: { ...base, name: 'zakria', avatar: '🦅', isUser: true, points: 301 }, seasonPoints: 1840, details: READY(card()) };
    case 'loading':
      return { competitor: base, seasonPoints: 5400, details: { status: 'loading' } };
    case 'failed':
      return { competitor: base, seasonPoints: 5400, details: { status: 'failed' } };
    case 'private':
      return { competitor: { ...base, isProfilePublic: false }, seasonPoints: 5400, details: READY(undefined) };
    case 'viewer-private':
      return { competitor: base, seasonPoints: 5400, details: READY(card()), viewerIsPublic: false };
    case 'partner':
      return { competitor: { ...base, isProfilePublic: false }, seasonPoints: 5400, details: READY(card()), isPartner: true };
    case 'large':
      return {
        competitor: { ...base, points: 128450, totalPoints: 999950 },
        seasonPoints: 999950,
        details: READY(
          card({
            days: 90,
            active: 88,
            streak: { days: 88, category: 'Habits' },
            habits: { done: 12500, due: 12800 },
            exercise: [
              { name: 'Push-ups', unit: 'reps', total: 125000, days: 88, best: 2500 },
              { name: 'Cycling', unit: 'km', total: 10250.5, days: 70, best: 320 },
            ],
            skills: { minutes: 99999, days: 88 },
            reading: { days: 80, booksThisSeason: 42, pages: 18750 },
            focus: { minutes: 45000, sessions: 900 },
          })
        ),
      };
    case 'no-card':
      return { competitor: base, seasonPoints: 5400, details: READY(undefined) };
    default:
      return { competitor: base, seasonPoints: 5400, details: READY(card()) };
  }
}

function MemberCardDemo() {
  const [open, setOpen] = useState<MemberDemoId | null>(null);
  const demo = memberDemo(open ?? 'public');
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {MEMBER_DEMOS.map((d) => (
          <Button key={d.id} size="sm" variant="secondary" onClick={() => setOpen(d.id)}>
            {d.label}
          </Button>
        ))}
      </div>
      <p className="text-micro text-content-muted">Numbers from 10,000 show compact (12.5k); the period label is This week.</p>
      <CompetitorProfileModal
        competitor={open ? demo.competitor : null}
        seasonPoints={demo.seasonPoints}
        periodLabel="This week"
        viewerIsPublic={demo.viewerIsPublic}
        isPartner={demo.isPartner}
        details={open ? demo.details : null}
        open={open !== null}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}

export function LeaguesGroup() {
  return (
    <>
      <Section id="tier-badges">
        <TierBadgesDemo />
      </Section>

      <Section id="rank-chip">
        <RankChipDemo />
      </Section>

      <Section id="league-rows">
        <LeagueRowsDemo />
      </Section>

      <Section id="league-countdown">
        <LeagueCountdownDemo />
      </Section>

      <Section id="member-card">
        <MemberCardDemo />
      </Section>

      <Section id="rank-up">
        <RankUpDemo />
      </Section>

      <Section id="league-results">
        <LeagueResultsDemo />
      </Section>
    </>
  );
}
