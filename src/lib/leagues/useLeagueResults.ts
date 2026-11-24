import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppStore } from '../store/store';
import { decideLeagueResults, type LeagueResultCard, type LeagueResultsDecision } from './leagueResults';
import { leagueNow } from '../time/leagueTime';

/** After the boot loader, the rank-up (900 ms) and What's New (1200 ms) delays, so those go first. */
const SHOW_DELAY_MS = 1500;

type ResultsStore = Pick<AppStore, 'isServerDataApplied' | 'isSessionLoading' | 'setLeagueResultsSeen'> & {
  state: Pick<AppStore['state'], 'currentUser' | 'leagueArchives' | 'leagueResultsSeen'>;
};

/**
 * Decides when the league results overlay shows (memory rules in lib/leagues/leagueResults). Only
 * once the signed-in account's server data is applied (`isServerDataApplied`), never on a device
 * cache. Waits while `blocked` (profile setup, a rank-up or the release note is due or open), so
 * overlays never stack. The memory is saved right before the overlay opens, so a reload or another
 * device never repeats it.
 */
export function useLeagueResults(store: ResultsStore, blocked: boolean) {
  const ready = store.isServerDataApplied && !store.isSessionLoading && Boolean(store.state.currentUser);
  const archives = store.state.leagueArchives;
  const stored = store.state.leagueResultsSeen;
  const { setLeagueResultsSeen } = store;

  const [cards, setCards] = useState<LeagueResultCard[] | null>(null);

  // Signed out or switching accounts: never carry an open overlay over.
  if (!ready && cards) setCards(null);

  const decision = useMemo<LeagueResultsDecision>(
    () => (ready ? decideLeagueResults(stored, archives, leagueNow().getTime()) : { kind: 'none' }),
    [ready, stored, archives]
  );
  // A sync that hands over a new archives array with the same outcome does not restart the delay.
  const signature = decision.kind === 'none' ? '' : `${decision.kind}:${JSON.stringify(decision.memory)}`;
  const decisionRef = useRef(decision);
  decisionRef.current = decision;

  useEffect(() => {
    const current = decisionRef.current;
    if (!signature || cards || current.kind === 'none') return;
    // Missing memory: fill it silently at once, nothing to wait for.
    if (current.kind === 'baseline') return setLeagueResultsSeen(current.memory);
    if (blocked) return;
    const timer = setTimeout(() => {
      const latest = decisionRef.current;
      if (latest.kind !== 'celebrate') return;
      setLeagueResultsSeen(latest.memory);
      setCards(latest.cards);
    }, SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [signature, cards, blocked, setLeagueResultsSeen]);

  return {
    leagueResults: cards,
    closeLeagueResults: () => setCards(null),
  };
}
