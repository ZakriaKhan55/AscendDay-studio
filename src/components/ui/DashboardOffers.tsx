import { useContext, useEffect, useState } from 'react';
import { appPlatform, installKind } from '@/lib/app/install';
import {
  canPromptInstall,
  installOfferDue,
  markOfferAnsweredThisLoad,
  offerAnsweredThisLoad,
  pickOfferSlot,
  readInstallOffer,
  useInstallPromptVersion,
  type OfferSlot,
} from '@/lib/app/installPrompt';
import { shouldOfferPush } from '@/lib/app/push';
import { trustedNowMs } from '@/lib/time/clock';
import { BootDialogOpenContext } from './bootDialogs';
import { InstallPromptCard, type InstallCardKind } from './InstallPromptCard';
import { PushPromptCard } from './PushPromptCard';

/**
 * The Dashboard's one offer slot for a signed-in account: the install card or the push card,
 * never both (pickOfferSlot decides the order). Nothing shows while a boot dialog is up. A card
 * once shown stays until answered (or AscendDay gets installed), even if the other becomes due
 * meanwhile: the browser's install offer can arrive late, and its dialog uses the offer up.
 */
export function DashboardOffers({ userId }: { userId: string }) {
  const bootDialogOpen = useContext(BootDialogOpenContext);
  useInstallPromptVersion();
  const [pushDue, setPushDue] = useState<boolean | null>(null);
  const [answered, setAnswered] = useState(offerAnsweredThisLoad);
  const [shown, setShown] = useState<OfferSlot>(null);
  // The install card's variant as first shown; kept while its install dialog uses the offer up.
  const [cardKind, setCardKind] = useState<InstallCardKind>('prompt');

  useEffect(() => {
    let active = true;
    setPushDue(null);
    shouldOfferPush()
      .then((next) => {
        if (active) setPushDue(next);
      })
      .catch(() => {
        if (active) setPushDue(false);
      });
    return () => {
      active = false;
    };
  }, [userId]);

  const platform = appPlatform();
  const kind = installKind({ canPrompt: canPromptInstall(), installedMark: readInstallOffer()?.installed === true });
  const installDue = installOfferDue({ record: readInstallOffer(), kind, platform, nowMs: trustedNowMs() });
  const installedNow = kind === 'installed' || kind === 'app';

  let slot: OfferSlot;
  if (answered) slot = null;
  else if (shown === 'install') slot = installedNow ? null : 'install';
  else if (shown === 'push' && pushDue) slot = 'push';
  else slot = pickOfferSlot({ platform, installDue, pushDue });
  if (!bootDialogOpen && slot !== null && slot !== shown) {
    setShown(slot);
    if (slot === 'install') setCardKind(kind === 'ios' || kind === 'in-app' ? kind : 'prompt');
  }

  if (bootDialogOpen || !slot) return null;

  const done = () => {
    markOfferAnsweredThisLoad();
    setAnswered(true);
  };

  if (slot === 'push') return <PushPromptCard userId={userId} onDone={done} />;
  return <InstallPromptCard kind={cardKind} onDone={done} />;
}
