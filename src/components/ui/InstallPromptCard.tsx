import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/primitives';
import { InstallGuideDialog } from '@/components/ui/InstallGuideDialog';
import { markInstallNotNow, promptInstall } from '@/lib/app/installPrompt';

export type InstallCardKind = 'prompt' | 'ios' | 'in-app';

/**
 * The Dashboard's offer to install AscendDay on this device (DashboardOffers decides when).
 * Install opens the browser's install dialog, or on iPhone/iPad the Add to Home Screen steps; an
 * in-app browser only says where to open AscendDay. "Not now", the dialog's Cancel and the
 * guide's Got it each use one offer (installPrompt.ts); installing ends the offers.
 */
export function InstallPromptCard({ kind, onDone }: { kind: InstallCardKind; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  const notNow = () => {
    markInstallNotNow();
    onDone();
  };

  const install = async () => {
    if (kind === 'ios') {
      setGuideOpen(true);
      return;
    }
    setBusy(true);
    try {
      const outcome = await promptInstall();
      if (outcome === 'dismissed') notNow();
      else if (outcome === 'accepted') onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 rounded-xl border border-primary-500/20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
      <div className="flex items-start gap-3 w-full sm:w-auto">
        <div className="w-9 h-9 rounded-xl bg-primary-500/15 flex items-center justify-center shrink-0 text-brand-text">
          <Download size={18} aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-content-secondary">Get the AscendDay app</p>
          <p className="text-xs text-content-muted">
            {kind === 'in-app' ? 'Open AscendDay in Safari or Chrome to install it.' : 'Open AscendDay in one tap and get reminders.'}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1 w-full sm:w-auto shrink-0">
        {kind !== 'in-app' && (
          <Button onClick={install} loading={busy} aria-haspopup={kind === 'ios' ? 'dialog' : undefined} className="min-h-11 text-xs flex-1 sm:flex-none">
            Install
          </Button>
        )}
        <Button variant="ghost" onClick={notNow} disabled={busy} className="min-h-11 text-xs">
          Not now
        </Button>
      </div>
      {kind === 'ios' && (
        <InstallGuideDialog
          open={guideOpen}
          onClose={() => {
            setGuideOpen(false);
            notNow();
          }}
        />
      )}
    </div>
  );
}
