// The league results overlay (ui/LeagueResultsOverlay.tsx), rendered with react-dom in the dom
// harness, reduced motion forced so each card settles after 250 ms:
//   - several results: one overlay, progress dots (sr "Result 1 of 3"), Next per card, Skip all;
//     cards go week -> month -> season and the last says Continue;
//   - Next waits until the card has landed; Skip all works at any time;
//   - copy per tier: 1st "You won the week!", 2nd "You finished 2nd", 4th+ "#N", alone no win;
//     the season card shows its final rank; UI says league, never group.
import { container, find, findAll, propsOf, textOf, type El } from './domTree';
import { buildLeagueResultCard } from '@/lib/leagues/leagueResults';
import type { LeagueArchive, LeagueType } from '@/types';

function assert(condition: unknown, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const React = await import('react');
const h = React.createElement;
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { LeagueResultsOverlay } = await import('../ui/LeagueResultsOverlay');

function card(type: LeagueType, id: string, rank: number, points: number[]) {
  const archive: LeagueArchive = {
    id,
    type,
    periodLabel: '',
    competitors: points.map((p, i) => ({ id: `c${i}`, name: `m${i}`, avatar: '🦊', points: p, totalPoints: 0, ...(i === rank - 1 ? { isUser: true } : {}) })),
    userRank: rank,
    userPoints: points[rank - 1],
    archivedAt: '2026-11-23T00:15:00.000Z',
    source: 'server',
  };
  return buildLeagueResultCard(archive, null);
}

const dialog = () => find((el) => el.getAttribute('role') === 'dialog', 'the overlay');
const buttons = () => findAll((el) => el.tagName === 'BUTTON' && dialog().contains(el));
const button = (label: string) => find((el) => el.tagName === 'BUTTON' && dialog().contains(el) && textOf(el).trim() === label, `the ${label} button`);
const heading = () => textOf(find((el) => el.tagName === 'H2' && dialog().contains(el), 'the card title'));
const click = (el: El) => flushSync(() => (propsOf(el).onClick as () => void)());

// Three results at once.
{
  let closed = 0;
  const root = createRoot(container());
  const cards = [
    card('ninetyDay', 'S:1', 1, [5000, 3000]),
    card('weekly', 'W:2026-W47', 4, [9, 8, 7, 6, 5]),
    card('monthly', 'M:2026-10', 2, [900, 800, 100]),
  ];
  // The hook orders them; the overlay shows them as given, so pass them in order here.
  const ordered = [cards[1], cards[2], cards[0]];
  flushSync(() => root.render(h(LeagueResultsOverlay, { cards: ordered, onClose: () => closed++, forceReducedMotion: true })));
  assert(textOf(dialog()).includes('Result 1 of 3'), 'progress for screen readers');
  assert(propsOf(button('Next')).disabled === true, 'Next waits for the card to land');
  assert(propsOf(button('Skip all')).disabled !== true, 'Skip all works at once');
  await wait(320);
  assert(heading() === 'You finished #4', `4th+ is calm (got "${heading()}")`);
  assert(textOf(dialog()).includes('#4 of 5'), 'place of members');
  assert(textOf(dialog()).includes('Weekly league results'), 'first card is the week');
  click(button('Next'));
  await wait(320);
  assert(heading() === 'You finished 2nd', `2nd is a medal (got "${heading()}")`);
  assert(textOf(dialog()).includes('Result 2 of 3'), 'progress moves');
  click(button('Next'));
  await wait(320);
  assert(heading() === 'You won the season!', `season 1st (got "${heading()}")`);
  assert(textOf(dialog()).includes('Final rank'), 'season card shows the final rank');
  assert(!buttons().some((b) => textOf(b).trim() === 'Skip all'), 'no Skip all on the last card');
  assert(!/group/i.test(textOf(dialog())), 'never says group');
  click(button('Continue'));
  assert(closed === 1, 'Continue on the last card closes');
  flushSync(() => root.unmount());
}

// Skip all closes from the first card; a single result has no dots and no Skip all.
{
  let closed = 0;
  const root = createRoot(container());
  flushSync(() =>
    root.render(
      h(LeagueResultsOverlay, {
        cards: [card('weekly', 'W:2026-W47', 1, [5, 4]), card('monthly', 'M:2026-10', 1, [9])],
        onClose: () => closed++,
        forceReducedMotion: true,
      })
    )
  );
  click(button('Skip all'));
  assert(closed === 1, 'Skip all closes');
  flushSync(() => root.unmount());

  const single = createRoot(container());
  flushSync(() => single.render(h(LeagueResultsOverlay, { cards: [card('weekly', 'W:2026-W47', 1, [120])], onClose: () => undefined, forceReducedMotion: true })));
  await wait(320);
  assert(!textOf(dialog()).includes('Result 1 of'), 'one result: no progress');
  assert(!buttons().some((b) => textOf(b).trim() === 'Skip all'), 'one result: no Skip all');
  assert(heading() === 'You finished the week', `alone is calm, not a win (got "${heading()}")`);
  assert(textOf(dialog()).includes('Only you scored in this league'), 'alone says so');
  flushSync(() => single.unmount());
}

console.log('leagueResultsOverlay: all passed');
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
