import { useEffect, useRef } from 'react';
import { confirmLeave } from '@/lib/ui/unsavedChanges';
import { weekFromParam } from '@/lib/time/weekParam';

/**
 * `?week=<key>` (the Sunday planning notice, also with the page already open): shows that week
 * once (a past or unreadable key: this week), then `onHandled` leaves the address, so reload and
 * back stay put. While `blocked` (the goal form or the delete dialog is open: a save there would
 * land in the other week) the request waits and is shown once it closes. Unsaved typing (a
 * reflection) or Reorder moves ask first, like the week arrows.
 */
export function useWeekRequest({
  requestedWeek,
  currentWeekKey,
  selectedWeekKey,
  blocked,
  onShow,
  onHandled,
}: {
  requestedWeek: string | null;
  currentWeekKey: string;
  selectedWeekKey: string;
  blocked: boolean;
  onShow: (week: string) => void;
  onHandled?: () => void;
}) {
  const handledWeekRef = useRef<string | null>(null);
  const onShowRef = useRef(onShow);
  onShowRef.current = onShow;
  useEffect(() => {
    if (requestedWeek === null) {
      handledWeekRef.current = null;
      return;
    }
    if (blocked || handledWeekRef.current === requestedWeek) return;
    handledWeekRef.current = requestedWeek;
    const target = weekFromParam(requestedWeek, currentWeekKey);
    if (target !== selectedWeekKey) confirmLeave(() => onShowRef.current(target));
    onHandled?.();
  }, [requestedWeek, currentWeekKey, selectedWeekKey, blocked, onHandled]);
}
