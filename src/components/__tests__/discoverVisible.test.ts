// Discover cards (discoverVisiblePlans): an own plan edited on this device and not synced yet comes
// back from the server under its old category and old text; its card leaves a list it no longer fits.
//   CR-02-6   moved to another category than the filtered one
//   (deferred P6 finding) title/description edited so it no longer matches the search text
import type { ImprovementPlan } from '@/types';
import { discoverSearchTerm, discoverVisiblePlans, planMatchesDiscoverSearch } from '../plans/discoverVisible';
import supabaseSrc from '../../lib/auth/supabase.ts?raw';

function assert(condition: unknown, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function plan(id: string, extra: Partial<ImprovementPlan> = {}): ImprovementPlan {
  return {
    id,
    creatorId: 'u1',
    creatorUsername: 'zak',
    title: 'Morning run',
    description: 'Run 5 km before work',
    category: 'Fitness',
    isPublic: true,
    steps: [],
    copyCount: 3,
    createdAt: '2026-11-01T10:00:00.000Z',
    ...extra,
  };
}

const ids = (list: ImprovementPlan[]) => list.map((p) => p.id).join(',');

// The search term is cleaned exactly like the server request.
{
  assert(/\.replace\(\/\[,\(\)\*%\\\\\]\/g, ' '\)\.trim\(\)/.test(supabaseSrc), 'server request still cleans the search the same way');
  assert(discoverSearchTerm('  run (5),km* ') === 'run  5  km', `term cleaned like the server (${discoverSearchTerm('  run (5),km* ')})`);
}

// Search match, like ilike '%term%'.
{
  const p = plan('a');
  assert(planMatchesDiscoverSearch(p, ''), 'empty search matches');
  assert(planMatchesDiscoverSearch(p, 'MORNING'), 'title, any case');
  assert(planMatchesDiscoverSearch(p, '5 km'), 'description');
  assert(planMatchesDiscoverSearch(p, 'm_rning'), '_ is any one character');
  assert(!planMatchesDiscoverSearch(p, 'swim'), 'no match');
  assert(planMatchesDiscoverSearch(plan('b', { title: 'a.b' }), 'a.b') && !planMatchesDiscoverSearch(plan('c', { title: 'axb' }), 'a.b'), '. is a plain character');
}

// Own plan edited so its text no longer matches the search: leaves Discover.
{
  const server = plan('own', { title: 'Morning run' });
  const editedHere = plan('own', { title: 'Evening swim', description: 'Pool laps', copyCount: 0 });
  const other = plan('other', { title: 'Morning yoga', creatorId: 'u2' });
  const own = new Map([[editedHere.id, editedHere]]);

  const searched = discoverVisiblePlans([server, other], own, { search: 'morning', category: 'All' });
  assert(ids(searched) === 'other', `edited own plan no longer matching the search leaves (${ids(searched)})`);

  const noSearch = discoverVisiblePlans([server, other], own, { search: '', category: 'All' });
  assert(ids(noSearch) === 'own,other', `no search: it stays (${ids(noSearch)})`);
  assert(noSearch[0].title === 'Evening swim' && noSearch[0].copyCount === 3, "the device's copy shows with the server's copy count");

  const stillMatches = discoverVisiblePlans([server], new Map([['own', plan('own', { title: 'Morning run, slower' })]]), { search: 'morning', category: 'All' });
  assert(ids(stillMatches) === 'own', 'edited text that still matches stays');

  // Text unchanged: the server's match stands, even where the client rule would differ.
  const sameText = discoverVisiblePlans([server], new Map([['own', plan('own')]]), { search: 'zzz', category: 'All' });
  assert(ids(sameText) === 'own', 'unchanged text: the server decided');
}

// CR-02-6: moved to another category than the filtered one.
{
  const server = plan('own', { category: 'Fitness' });
  const moved = new Map([['own', plan('own', { category: 'Mindset' })]]);
  assert(ids(discoverVisiblePlans([server], moved, { search: '', category: 'Fitness' })) === '', 'moved out of the filtered category leaves');
  assert(ids(discoverVisiblePlans([server], moved, { search: '', category: 'All' })) === 'own', 'All categories: stays');
}

// Own plan made private here: gone; other people's plans pass through.
{
  const other = plan('x', { creatorId: 'u2' });
  const priv = new Map([['own', plan('own', { isPublic: false })]]);
  assert(ids(discoverVisiblePlans([plan('own'), other], priv, { search: '', category: 'All' })) === 'x', 'private own plan leaves');
}

console.log('discoverVisible fixtures passed');
