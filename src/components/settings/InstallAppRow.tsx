import { useState } from 'react';
import { Button } from '@/components/ui/primitives';
import { InstallGuideDialog } from '@/components/ui/InstallGuideDialog';
import { installKind, installRowText } from '@/lib/app/install';
import { canPromptInstall, promptInstall, readInstallOffer, useInstallPromptVersion } from '@/lib/app/installPrompt';
import { SettingRow } from './SettingRow';

/**
 * Settings → App info: install AscendDay on this device. One tap opens the browser's install
 * dialog where it offers one; on iPhone and iPad it opens the Add to Home Screen steps; elsewhere
 * it says where the browser keeps it. Never counts toward the Dashboard card's offers.
 */
export function InstallAppRow({ guest }: { guest: boolean }) {
  useInstallPromptVersion();
  const [guideOpen, setGuideOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const kind = installKind({ canPrompt: canPromptInstall(), installedMark: readInstallOffer()?.installed === true });

  const install = async () => {
    setBusy(true);
    try {
      await promptInstall();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingRow
        title="Install app"
        description={installRowText(kind)}
        control={
          kind === 'prompt' || busy ? (
            <Button size="sm" onClick={install} loading={busy}>
              Install
            </Button>
          ) : kind === 'ios' ? (
            <Button variant="secondary" size="sm" onClick={() => setGuideOpen(true)} aria-haspopup="dialog">
              How to install
            </Button>
          ) : undefined
        }
      />
      <InstallGuideDialog open={guideOpen} onClose={() => setGuideOpen(false)} guest={guest} />
    </>
  );
}
