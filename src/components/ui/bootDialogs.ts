import { createContext } from 'react';

/**
 * True while a boot dialog is up or queued (profile setup, rank-up, What's New, league results;
 * AppShell). The Dashboard's offer cards wait for it, so no card appears under a modal.
 */
export const BootDialogOpenContext = createContext(false);
