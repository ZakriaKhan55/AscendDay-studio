import { Dialog } from './primitives/Dialog';

const STEPS: { title: string; text: string }[] = [
  { title: 'Tap Share', text: 'The square with an arrow. On newer iPhones, tap ••• first.' },
  { title: 'Tap Add to Home Screen', text: 'Scroll down the list if you don’t see it.' },
  { title: 'Open AscendDay from your Home Screen', text: 'Sign in once there. The app keeps its own sign-in.' },
];

/** The steps (without the Dialog shell, so the gallery can show them). */
export function InstallGuideBody({ guest = false }: { guest?: boolean }) {
  return (
    <div className="space-y-4">
      <ol className="divide-y divide-overlay-subtle border-y border-overlay-subtle">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex gap-3 py-3.5">
            <span
              aria-hidden="true"
              className="figure flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-overlay-default bg-overlay-subtle text-xs font-medium text-content-tertiary"
            >
              {i + 1}
            </span>
            <div className="min-w-0 space-y-1">
              <h3 className="item-name text-sm">{step.title}</h3>
              <p className="text-xs leading-relaxed text-content-tertiary">{step.text}</p>
            </div>
          </li>
        ))}
      </ol>
      {guest && (
        <p className="text-xs leading-relaxed text-content-tertiary">
          Create your account first. As a guest, your data stays in this browser and doesn’t move to the app.
        </p>
      )}
    </div>
  );
}

/**
 * iPhone and iPad have no install button for websites: this says how to add AscendDay to the
 * Home Screen. The Home Screen app keeps its own storage, so it starts signed out (and a guest's
 * data stays behind in the browser).
 */
export function InstallGuideDialog({ open, onClose, guest = false }: { open: boolean; onClose: () => void; guest?: boolean }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Install AscendDay"
      description="Add it to your Home Screen to open it like an app."
      footer={
        <button type="button" onClick={onClose} className="btn-secondary">
          Got it
        </button>
      }
    >
      <InstallGuideBody guest={guest} />
    </Dialog>
  );
}
