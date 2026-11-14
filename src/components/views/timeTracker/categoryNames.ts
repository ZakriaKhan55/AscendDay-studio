import type { TimeTrackerActivity } from '@/types';
import { trustedNow } from '@/lib/time/clock';
import { nameKey, nameTaken } from '@/lib/items/uniqueNames';

/** Category names follow the app's one name rule (lib/uniqueNames): " Deep  work" = "deep work". */
export const categoryNameKey = nameKey;

/**
 * True when another category (built-in included) already has this name. A category keeping its
 * own current name is fine, so old duplicates can still be edited without renaming.
 */
export function categoryNameTaken(
  name: string,
  activities: TimeTrackerActivity[],
  editing?: TimeTrackerActivity | null
): boolean {
  return nameTaken(name, activities, { editing });
}

function madeLabel(createdAt?: string): string {
  if (!createdAt) return '';
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === trustedNow().getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/**
 * Names to show where categories sit side by side: two with the same name get "· made <date>"
 * (from createdAt) so they can be told apart. Two still alike (made the same day, or with no date)
 * get " (2)", " (3)" after the first, oldest first, so the numbers never move when the list is
 * reordered. Keyed by category id.
 */
export function categoryDisplayNames(activities: TimeTrackerActivity[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const a of activities) counts.set(categoryNameKey(a.name), (counts.get(categoryNameKey(a.name)) || 0) + 1);
  const out = new Map<string, string>();
  for (const a of activities) {
    const dup = (counts.get(categoryNameKey(a.name)) || 0) > 1;
    const made = dup ? madeLabel(a.createdAt) : '';
    out.set(a.id, made ? `${a.name} · made ${made}` : a.name);
  }
  const alike = new Map<string, TimeTrackerActivity[]>();
  for (const a of activities) {
    const key = categoryNameKey(out.get(a.id) || '');
    alike.set(key, [...(alike.get(key) || []), a]);
  }
  for (const group of alike.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((x, y) => (x.createdAt || '').localeCompare(y.createdAt || '') || x.id.localeCompare(y.id));
    ordered.forEach((a, i) => {
      if (i > 0) out.set(a.id, `${out.get(a.id)} (${i + 1})`);
    });
  }
  return out;
}
