import type { TaskSubtask } from '@/types';
import { uid } from '@/lib/time/dates';
import { trustedNow } from '@/lib/time/clock';

/** Dates outside two years back to twenty years ahead are pulled to the nearest bound. */
export function dateBounds() {
  const year = trustedNow().getFullYear();
  return { min: `${year - 2}-01-01`, max: `${year + 20}-12-31` };
}

/**
 * The date to save from a date field. The item's own saved date stays as it is, even once it is
 * older than the moving lower bound; any other date is pulled into the bounds.
 */
export function sanitizeDate(value: string, saved?: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === saved) return saved;
  const { min, max } = dateBounds();
  return trimmed < min ? min : trimmed > max ? max : trimmed;
}

/** The task's subtasks to save: titles trimmed, plus a subtask typed in "Add a subtask" but not added yet. */
export function subtasksToSave(subtasks: TaskSubtask[], pendingTitle: string): TaskSubtask[] {
  const saved = subtasks.map((st) => ({ ...st, title: st.title.trim() }));
  const pending = pendingTitle.trim();
  return pending ? [...saved, { id: uid(), title: pending, completed: false }] : saved;
}
