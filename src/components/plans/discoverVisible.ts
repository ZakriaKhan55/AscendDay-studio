import type { ImprovementPlan } from '@/types';

/** The Discover filters the server applied to the list (useDiscoverPlans). */
export interface DiscoverListFilters {
  search: string;
  category: string;
}

/**
 * The search text as fetchPublicPlansFromSupabase sends it: characters that would break the or()
 * filter become spaces, then trimmed.
 */
export function discoverSearchTerm(search: string): string {
  return (search || '').replace(/[,()*%\\]/g, ' ').trim();
}

/** Whether `text` matches the server's `ilike '%term%'` (case-insensitive; `_` is any one character). */
function ilikeContains(text: string, term: string): boolean {
  const pattern = term
    .split('_')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.');
  return new RegExp(pattern, 'is').test(text || '');
}

/** Whether a plan's title or description matches the Discover search, as the server checks it. */
export function planMatchesDiscoverSearch(plan: Pick<ImprovementPlan, 'title' | 'description'>, search: string): boolean {
  const term = discoverSearchTerm(search);
  if (!term) return true;
  return ilikeContains(plan.title, term) || ilikeContains(plan.description, term);
}

/**
 * The Discover cards to show. The server filtered by category and search text; the user's own plans
 * show this device's copy (newest edits, sharing). An own plan edited on this device and not synced
 * yet still came back under its old category and old text, so its card leaves a list it no longer
 * fits: moved to another category, or a title/description that no longer matches the search.
 */
export function discoverVisiblePlans(
  plans: readonly ImprovementPlan[],
  ownById: ReadonlyMap<string, ImprovementPlan>,
  filters: DiscoverListFilters
): ImprovementPlan[] {
  return plans
    .flatMap((p) => {
      const own = ownById.get(p.id);
      if (!own) return [p];
      const movedOut = own.category !== p.category && filters.category !== 'All' && own.category !== filters.category;
      const textChanged = own.title !== p.title || own.description !== p.description;
      const searchedOut = textChanged && !planMatchesDiscoverSearch(own, filters.search);
      return movedOut || searchedOut ? [] : [{ ...own, copyCount: p.copyCount }];
    })
    .filter((p) => p.isPublic);
}
