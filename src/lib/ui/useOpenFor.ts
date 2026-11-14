import { useCallback, useState } from 'react';

/**
 * Open state of a confirm dialog that belongs to one thing on screen (a focus session, a day). It
 * shows only while that thing is the one on screen and closes for good when it changes (a session
 * that ends or another that starts, the page moving to the new day at midnight), so it never
 * carries over to, or acts on, the next one.
 */
export function useOpenFor(current: string | null | undefined) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  // Reset during render (no frame with the dialog on the new one), like useZoneSheetOpen.
  if (openFor !== null && openFor !== current) setOpenFor(null);
  const show = useCallback(() => setOpenFor(current ?? null), [current]);
  const hide = useCallback(() => setOpenFor(null), []);
  return [openFor !== null && openFor === current, show, hide] as const;
}
