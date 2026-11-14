import { useCallback, useState } from 'react';

/**
 * Open state of the phone zone sheet. It closes when the zone on screen changes (phone Back to the
 * Dashboard or to another zone): otherwise it stays "open" with no sheet showing, and pops up
 * again on the next page of a zone.
 */
export function useZoneSheetOpen(zone: string | null | undefined) {
  const [open, setOpen] = useState(false);
  // Derived during render (no frame with the old zone's sheet), like Quick log's launch flag.
  const [shownZone, setShownZone] = useState(zone);
  if (zone !== shownZone) {
    setShownZone(zone);
    if (open) setOpen(false);
  }
  const close = useCallback(() => setOpen(false), []);
  return [open, setOpen, close] as const;
}
