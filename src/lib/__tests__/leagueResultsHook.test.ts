// useLeagueResults (lib/leagues/useLeagueResults.ts), rendered in Node with the dom harness and a
// small fake store (the hook reads only these fields):
//   H1 nothing is decided or saved until the account's server data is applied (never on a cache);
//   H2 missing memory is filled silently at once, nothing shows (no backlog);
//   H3 a new result shows after the delay, the memory is saved before the overlay opens;
//   H4 while blocked (another boot overlay due or open) it waits, then shows;
//   H5 another device that got the memory through the settings merge never shows it again;
//   H6 signing out drops an open overlay.
import { doc } from './harness/dom';
import type { LeagueArchive, LeagueResultsSeen } from '@/types';

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { useLeagueResults } = await import('../leagues/useLeagueResults');
const { mergeLeagueResultsSeen } = await import('../leagues/leagueResults');

function assert(condition: unknown, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) =>
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const container = () => (doc.createElement as () => Element)();
const SHOW_DELAY_MS = 1500;

function archive(id: string, type: LeagueArchive['type'], userRank: number): LeagueArchive {
  return {
    id,
    type,
    periodLabel: '',
    competitors: [
      { id: 'a', name: 'a', avatar: '🦊', points: 300, totalPoints: 0, ...(userRank === 1 ? { isUser: true } : {}) },
      { id: 'b', name: 'b', avatar: '🐺', points: 200, totalPoints: 0, ...(userRank === 2 ? { isUser: true } : {}) },
    ],
    userRank,
    userPoints: userRank === 1 ? 300 : 200,
    archivedAt: '2026-11-23T00:15:00.000Z',
    source: 'server',
    final: false,
  };
}
// Both periods ended before this test can run (W47 = Nov 16-22 2026, October 2026).
const ARCHIVES = [archive('W:2026-W46', 'weekly', 2), archive('W:2026-W47', 'weekly', 1), archive('M:2026-10', 'monthly', 2)];
const OLD: LeagueResultsSeen = { weekly: 'W:2026-W46', monthly: 'M:2026-10', ninetyDay: null };
const NEW: LeagueResultsSeen = { weekly: 'W:2026-W47', monthly: 'M:2026-10', ninetyDay: null };

interface Device {
  saves: LeagueResultsSeen[];
  log: string[];
  memory: () => LeagueResultsSeen | null;
  cards: () => ReturnType<typeof useLeagueResults>['leagueResults'];
  close: () => void;
  render: (p: { applied?: boolean; signedIn?: boolean; blocked?: boolean; memory?: LeagueResultsSeen | null }) => void;
  unmount: () => void;
}

function device(initial: LeagueResultsSeen | null): Device {
  const saves: LeagueResultsSeen[] = [];
  const log: string[] = [];
  let latest!: ReturnType<typeof useLeagueResults>;
  let memory: LeagueResultsSeen | null = initial;
  let props = { applied: false, signedIn: true, blocked: false };
  const root = createRoot(container());
  const draw = () => flushSync(() => root.render(React.createElement(Probe)));
  function Probe() {
    const [stored, setStored] = React.useState(memory);
    if (stored !== memory) setStored(memory);
    latest = useLeagueResults(
      {
        isServerDataApplied: props.applied,
        isSessionLoading: false,
        // Like the store: the save merges into the settings doc at once.
        setLeagueResultsSeen: (m: LeagueResultsSeen) => {
          saves.push(m);
          log.push('save');
          memory = mergeLeagueResultsSeen(memory, m);
          setStored(memory);
        },
        state: {
          currentUser: props.signedIn ? ({ id: 'me' } as never) : null,
          leagueArchives: ARCHIVES,
          leagueResultsSeen: stored,
        },
      },
      props.blocked
    );
    if (latest.leagueResults && log[log.length - 1] !== 'open') log.push('open');
    return null;
  }
  draw();
  return {
    saves,
    log,
    memory: () => memory,
    cards: () => latest.leagueResults,
    close: () => flushSync(() => latest.closeLeagueResults()),
    render: (p) => {
      if (p.memory !== undefined) memory = p.memory;
      props = { ...props, ...p };
      draw();
    },
    unmount: () => flushSync(() => root.unmount()),
  };
}

// H1 + H3: a cached device (server data not applied) never decides; once applied it shows after the
// delay, saving first.
{
  const d = device(OLD);
  await wait(SHOW_DELAY_MS + 300);
  eq(d.saves.length, 0, 'H1: nothing saved on a device cache');
  eq(d.cards(), null, 'H1: nothing shown on a device cache');
  d.render({ applied: true });
  await wait(SHOW_DELAY_MS - 400);
  eq(d.cards(), null, 'H3: not before the delay');
  await wait(700);
  eq(d.cards()?.map((c) => c.periodId), ['W:2026-W47'], 'H3: the new week shows');
  eq(d.saves, [NEW], 'H3: memory saved once, for the shown week');
  eq(d.log, ['save', 'open'], 'H3: saved before the overlay opened');
  d.close();
  await wait(SHOW_DELAY_MS + 300);
  eq(d.cards(), null, 'H3: closed and never again on this device');
  eq(d.saves.length, 1, 'H3: no further save');
  d.unmount();
}

// H2: missing memory baselines silently at once.
{
  const d = device(null);
  d.render({ applied: true });
  await wait(50);
  eq(d.saves, [NEW], 'H2: baseline saved at once to the newest results');
  await wait(SHOW_DELAY_MS + 300);
  eq(d.cards(), null, 'H2: nothing shown (no backlog)');
  eq(d.saves.length, 1, 'H2: one save only');
  d.unmount();
}

// H4: blocked waits, then shows.
{
  const d = device(OLD);
  d.render({ applied: true, blocked: true });
  await wait(SHOW_DELAY_MS + 300);
  eq(d.cards(), null, 'H4: waits while blocked');
  eq(d.saves.length, 0, 'H4: nothing saved while blocked');
  d.render({ blocked: false });
  await wait(SHOW_DELAY_MS + 300);
  eq(d.cards()?.length, 1, 'H4: shows once unblocked');
  d.unmount();
}

// H5: device A showed it; device B (older memory on its cache) gets A's memory through the settings
// merge with server data and never shows it.
{
  const a = device(OLD);
  a.render({ applied: true });
  await wait(SHOW_DELAY_MS + 300);
  eq(a.cards()?.length, 1, 'H5: device A shows the week');
  const b = device(OLD);
  // Hydration: B's cache merged with the server's settings doc, then server data applied.
  b.render({ memory: mergeLeagueResultsSeen(OLD, a.memory()), applied: true });
  await wait(SHOW_DELAY_MS + 300);
  eq(b.cards(), null, 'H5: device B never shows it again');
  eq(b.saves.length, 0, 'H5: device B saves nothing');
  a.unmount();
  b.unmount();
}

// H6: signing out drops an open overlay.
{
  const d = device(OLD);
  d.render({ applied: true });
  await wait(SHOW_DELAY_MS + 300);
  eq(d.cards()?.length, 1, 'H6: open');
  d.render({ signedIn: false });
  eq(d.cards(), null, 'H6: signed out drops it');
  d.unmount();
}

console.log('leagueResultsHook: all passed');
(globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
