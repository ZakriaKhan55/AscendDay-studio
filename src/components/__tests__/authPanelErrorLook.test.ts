// AuthPanel error look (design rule: one FieldErrorBubble look, no loose red text in forms). The
// forgot-password "sent" screen showed a failed resend as plain red text; it now uses the form-wide
// bubble like the confirmation-email resend. Source check (the panel needs the whole auth flow to render).
import src from '../ui/AuthPanel.tsx?raw';

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

assert(/\{resendError && <FieldErrorBubble message=\{resendError\} attached=\{false\} \/>\}/.test(src), 'password reset resend error uses the form-wide bubble');
assert(!/<p role="alert" className="text-xs text-error-text">/.test(src), 'no loose red error text left in the panel');

console.log('authPanelErrorLook: all checks passed');
