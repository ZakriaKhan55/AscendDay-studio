import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Medal, Trophy } from 'lucide-react';
import { Button, cx } from './primitives';
import { TierBadge } from './TierBadge';
import { useReducedMotion } from '@/lib/ui/motion';
import { celebrationFeedback } from '@/lib/ui/actionFeedback';
import type { LeagueResultCard } from '@/lib/leagues/leagueResults';
import { leagueResultVibration, leagueStingHitMs, playLeagueResultSting } from '@/lib/leagues/leagueResultsSound';
import type { LeagueType } from '@/types';

/**
 * Full-screen league results moment, one card per league that just ended (week, month, then the
 * season as the finale), with progress dots, Next per card and Skip all. Each card lands its emblem
 * with a sting: 1st the full show (trophy, burst, fanfare), 2nd/3rd a medal and chime, 4th+ or
 * alone on the board a calm "You finished #N". Esc or Skip all closes; focus stays inside.
 * Reduced motion: no particles, the card fades in. Uses the rank-up overlay's classes (index.css).
 */

export interface LeagueResultsOverlayProps {
  cards: LeagueResultCard[];
  onClose: () => void;
  /** Play the sting whatever the user's tick feedback choice (the gallery). */
  forceSound?: boolean;
  /** Show the reduced motion version whatever the device setting (the gallery). */
  forceReducedMotion?: boolean;
}

const PERIOD_WORD: Record<LeagueType, string> = { weekly: 'week', monthly: 'month', ninetyDay: 'season' };
const LEAGUE_NAME: Record<LeagueType, string> = { weekly: 'Weekly league', monthly: 'Monthly league', ninetyDay: 'Season league' };

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

function medalVar(place: number): string {
  return place === 1 ? 'var(--medal-gold)' : place === 2 ? 'var(--medal-silver)' : 'var(--medal-bronze)';
}

/** Colours for the rank-up classes: the medal of the place, emerald for a calm card. */
function cardVars(card: LeagueResultCard): CSSProperties {
  if (card.tier === 'calm') {
    return {
      '--ru-glow': 'var(--color-brand-mark)',
      '--ru-text': 'var(--badge-emerald-text)',
      '--ru-bg': 'var(--badge-emerald-bg)',
      '--ru-border': 'var(--badge-emerald-border)',
    } as CSSProperties;
  }
  const medal = medalVar(card.place);
  return {
    '--ru-glow': medal,
    '--ru-text': medal,
    '--ru-bg': `color-mix(in srgb, ${medal} 12%, transparent)`,
    '--ru-border': `color-mix(in srgb, ${medal} 45%, transparent)`,
  } as CSSProperties;
}

function title(card: LeagueResultCard): string {
  const word = PERIOD_WORD[card.type];
  if (card.alone) return `You finished the ${word}`;
  if (card.tier === 'first') return `You won the ${word}!`;
  if (card.tier === 'podium') return `You finished ${ordinal(card.place)}`;
  return `You finished #${card.place}`;
}

function deltaText(card: LeagueResultCard): string | null {
  if (!card.delta) return null;
  const { places, points } = card.delta;
  const move =
    places > 0 ? `Up ${places} ${places === 1 ? 'place' : 'places'}` : places < 0 ? `Down ${-places} ${places === -1 ? 'place' : 'places'}` : 'Same place';
  const pts = `${points >= 0 ? '+' : '−'}${Math.abs(points).toLocaleString()} pts`;
  return `${move} · ${pts} on last ${PERIOD_WORD[card.type]}`;
}

/** Repeatable pseudo-random 0..1 per spark, so a render never reshuffles them. */
function noise(i: number, salt: number): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function sparksFor(count: number): Array<{ key: number; diamond: boolean; style: CSSProperties }> {
  return Array.from({ length: count }, (_, i) => {
    const angle = ((i + noise(i, 1) * 0.6) / count) * Math.PI * 2;
    const distance = 100 + noise(i, 2) * 130;
    const size = 3 + Math.round(noise(i, 3) * 4);
    return {
      key: i,
      diamond: i % 3 === 0,
      style: {
        width: size,
        height: size,
        '--ru-x': `${Math.cos(angle) * distance}px`,
        '--ru-y': `${Math.sin(angle) * distance}px`,
        '--ru-dur': `${900 + Math.round(noise(i, 4) * 800)}ms`,
        '--ru-delay': `${Math.round(noise(i, 5) * 160)}ms`,
        '--ru-spark': i % 2 === 0 ? 'var(--ru-glow)' : '#fff',
      } as CSSProperties,
    };
  });
}

/** Ms from the card appearing: the emblem lands, then the text settles. */
function timeline(card: LeagueResultCard, reduced: boolean) {
  if (reduced) return { landAt: 250, textAt: 250 };
  const landAt = card.tier === 'first' ? 700 : card.tier === 'podium' ? 450 : 350;
  return { landAt, textAt: landAt + (card.tier === 'first' ? 520 : 360) };
}

function Podium({ card }: { card: LeagueResultCard }) {
  // 2nd, 1st, 3rd from left to right.
  const order = [card.podium[1], card.podium[0], card.podium[2]].filter(Boolean);
  const height: Record<number, string> = { 1: 'h-14', 2: 'h-10', 3: 'h-7' };
  return (
    <ol aria-label="Top three" className="mt-6 grid w-full grid-cols-3 items-end gap-2">
      {order.map((entry) => (
        <li key={entry.place} className="flex min-w-0 flex-col items-center gap-1">
          <span
            aria-hidden="true"
            className={cx(
              'flex h-10 w-10 items-center justify-center rounded-xl text-xl',
              entry.isUser ? 'bg-overlay-default ring-2 ring-[var(--color-brand-mark)]' : 'bg-overlay-subtle'
            )}
          >
            {entry.avatar}
          </span>
          <span className="flex w-full min-w-0 items-center justify-center gap-1">
            <span className="truncate text-xs font-medium text-content-secondary">{entry.name}</span>
            {entry.isUser && <span className="badge badge-emerald shrink-0">You</span>}
          </span>
          <span className="figure text-2xs text-content-muted">{entry.points.toLocaleString()} pts</span>
          <span
            className={cx('flex w-full items-start justify-center rounded-t-lg border-t-2 bg-overlay-subtle pt-1', height[entry.place])}
            style={{ borderColor: medalVar(entry.place) }}
          >
            <span className="sr-only">{ordinal(entry.place)}: </span>
            <span aria-hidden="true" className="figure text-xs font-semibold" style={{ color: medalVar(entry.place) }}>
              {entry.place}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

interface CardProps {
  card: LeagueResultCard;
  reduced: boolean;
  forceSound: boolean;
  titleId: string;
  descId: string;
  onSettled: () => void;
}

function ResultCard({ card, reduced, forceSound, titleId, descId, onSettled }: CardProps) {
  const [phase, setPhase] = useState<'intro' | 'landed' | 'settled'>('intro');
  const [times] = useState(() => timeline(card, reduced));
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const finale = card.type === 'ninetyDay';

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, run: () => void) => timers.push(setTimeout(run, Math.max(0, ms)));
    at(times.landAt, () => setPhase('landed'));
    at(times.textAt, () => {
      setPhase('settled');
      onSettledRef.current();
    });
    at(times.landAt - (reduced ? 0 : leagueStingHitMs(card.tier)), () =>
      celebrationFeedback(
        (ctx, peak) => playLeagueResultSting(ctx, peak, card.tier, finale),
        leagueResultVibration(card.tier, finale),
        forceSound
      )
    );
    return () => timers.forEach(clearTimeout);
  }, [times, card.tier, finale, reduced, forceSound]);

  const landed = phase !== 'intro';
  const settled = phase === 'settled';
  const rise = settled && !reduced ? 'rankup-rise' : '';
  const delta = deltaText(card);
  const big = card.tier === 'first';
  const sparks = big ? sparksFor(finale ? 34 : 24) : [];
  const Icon = big ? Trophy : Medal;

  return (
    <div className="relative flex w-full flex-col items-center text-center" style={cardVars(card)}>
      {landed && !reduced && card.tier !== 'calm' && (
        <div aria-hidden="true" className="rankup-wash pointer-events-none fixed inset-0" />
      )}

      {/* The emblem stage. */}
      <div aria-hidden="true" className="relative flex h-48 w-48 items-center justify-center">
        {landed && !reduced && card.tier !== 'calm' && (
          <>
            {big && finale && <div className="rankup-rays pointer-events-none absolute h-[30rem] w-[30rem] rounded-full" />}
            <div className="rankup-halo absolute h-56 w-56 rounded-full" />
            {big && <div className="rankup-flash absolute h-28 w-28 rounded-full" />}
            {Array.from({ length: big ? 3 : 1 }, (_, i) => (
              <div key={i} className="rankup-ring absolute h-28 w-28 rounded-full" style={{ animationDelay: `${i * 140}ms` }} />
            ))}
            {sparks.map((spark) => (
              <span
                key={spark.key}
                className={cx('rankup-spark absolute rounded-full', spark.diamond && 'rankup-spark-diamond')}
                style={spark.style}
              />
            ))}
          </>
        )}
        <div
          className={cx(
            'relative h-[6.5rem] w-[6.5rem]',
            reduced ? 'rankup-fade' : landed ? (card.tier === 'calm' ? 'rankup-in' : 'rankup-pop') : '',
            !landed && 'opacity-0'
          )}
        >
          <div
            className={cx(
              'rankup-badge absolute inset-0 flex items-center justify-center rounded-[28px]',
              landed && card.tier !== 'calm' && 'rankup-badge-landed'
            )}
          >
            {card.tier === 'calm' ? (
              <span className="font-serif text-[2.75rem] leading-none">#{card.place}</span>
            ) : (
              <Icon size={big ? 52 : 46} strokeWidth={1.75} />
            )}
          </div>
        </div>
      </div>

      {/* In the tree from the start for screen readers, shown once the emblem lands. */}
      <div className={cx('mt-3 flex w-full flex-col items-center', reduced && 'rankup-fade', !settled && 'opacity-0')}>
        <p className={cx('text-sm font-semibold', rise)} style={{ color: 'var(--ru-text)' }}>
          {card.type === 'ninetyDay' && card.seasonNumber !== null ? `Season ${card.seasonNumber} results` : `${LEAGUE_NAME[card.type]} results`}
        </p>
        <p className={cx('mt-0.5 text-xs text-content-muted', rise)}>{card.periodLabel}</p>
        <h2
          id={titleId}
          className={cx('mt-2 font-serif text-[2.25rem] leading-[1.05] tracking-[-0.01em] text-content-primary sm:text-[2.75rem]', rise)}
          style={{ '--ru-delay': '70ms' } as CSSProperties}
        >
          {title(card)}
        </h2>
        <p id={descId} className={cx('figure mt-2 text-sm text-content-secondary', rise)} style={{ '--ru-delay': '140ms' } as CSSProperties}>
          {card.alone ? 'Only you scored in this league' : `#${card.place} of ${card.of}`} · {card.points.toLocaleString()} pts
        </p>
        {delta && (
          <p className={cx('figure mt-1 text-xs text-content-muted', rise)} style={{ '--ru-delay': '180ms' } as CSSProperties}>
            {delta}
          </p>
        )}
        {finale && (
          <div className={cx('mt-4 flex flex-col items-center gap-1', rise)} style={{ '--ru-delay': '200ms' } as CSSProperties}>
            <span className="stat-label">Final rank</span>
            <TierBadge totalPoints={card.points} size="md" showName />
          </div>
        )}
        {!card.alone && card.podium.length >= 2 && (
          <div className={cx('w-full', rise)} style={{ '--ru-delay': '240ms' } as CSSProperties}>
            <Podium card={card} />
          </div>
        )}
      </div>
    </div>
  );
}

export function LeagueResultsOverlay({ cards, onClose, forceSound = false, forceReducedMotion = false }: LeagueResultsOverlayProps) {
  const systemReduced = useReducedMotion();
  // Fixed for the overlay's life: a motion change mid-show does not restart it.
  const [reduced] = useState(() => forceReducedMotion || systemReduced);
  const [index, setIndex] = useState(0);
  const [settled, setSettled] = useState(false);
  const [exiting, setExiting] = useState(false);
  const titleId = useId();
  const descId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const card = cards[Math.min(index, cards.length - 1)];
  const isLast = index >= cards.length - 1;
  const many = cards.length > 1;

  const close = () => {
    if (exiting) return;
    if (reduced) return onCloseRef.current();
    setExiting(true);
    setTimeout(() => onCloseRef.current(), 260);
  };
  const next = () => {
    if (isLast) return close();
    setSettled(false);
    setIndex((i) => i + 1);
    rootRef.current?.focus({ preventScroll: true });
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // Dialog behaviour: page scroll locked, focus held inside, Esc closes (before any dialog under it).
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    rootRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const buttons = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        if (!buttons.length) return rootRef.current?.focus();
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const step = event.shiftKey ? -1 : 1;
        buttons[(at + step + buttons.length) % buttons.length].focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (settled) nextRef.current?.focus({ preventScroll: true });
  }, [settled]);

  if (!card) return null;

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      tabIndex={-1}
      className={cx(
        'fixed inset-0 flex justify-center overflow-x-hidden overflow-y-auto overscroll-contain px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))] outline-none',
        exiting && 'rankup-exit pointer-events-none'
      )}
      style={{ zIndex: 'calc(var(--z-blocking) + 10)' }}
    >
      <div aria-hidden="true" className="rankup-backdrop animate-enter-fade fixed inset-0" />

      {/* my-auto centres it; on a screen too short for it, it starts at the top and scrolls. */}
      <div className="relative my-auto flex w-full max-w-sm flex-col items-center">
        {many && (
          <div className="mb-2 flex items-center gap-1.5">
            <span className="sr-only">
              Result {index + 1} of {cards.length}
            </span>
            {cards.map((c, i) => (
              <span
                key={c.periodId}
                aria-hidden="true"
                className={cx(
                  'h-1.5 rounded-full transition-all duration-300',
                  i === index ? 'w-5 bg-[var(--color-brand-mark)]' : i < index ? 'w-1.5 bg-content-muted' : 'w-1.5 bg-overlay-strong'
                )}
              />
            ))}
          </div>
        )}

        <ResultCard
          key={card.periodId}
          card={card}
          reduced={reduced}
          forceSound={forceSound}
          titleId={titleId}
          descId={descId}
          onSettled={() => setSettled(true)}
        />

        <div className="mt-7 flex w-full flex-col items-center gap-1">
          <div className={cx('flex w-full justify-center', !settled && 'opacity-0', settled && !reduced && 'rankup-rise')}>
            <Button ref={nextRef} onClick={next} disabled={!settled} className="w-full max-w-[16rem]">
              {isLast ? 'Continue' : 'Next'}
            </Button>
          </div>
          {/* Usable at any time, also while a card is still landing. */}
          {many && !isLast && (
            <Button variant="ghost" size="sm" onClick={close}>
              Skip all
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
