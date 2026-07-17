// Notifier interface: consumer-injected adapter for toast/notification
// display. Replaces the app-specific toast.ts import. The framework
// calls these during the action lifecycle (success/error toasts).
// ---------------------------------------------------------------------------

/** Retry button descriptor passed to error notifications. */
export interface NotifierRetry {
  readonly onClick: () => void;
}

/** Consumer-provided notification adapter. Implement this interface
 *  and pass it to `configure()` to wire up toast/notification display.
 *
 *  All methods are optional — when not provided, the framework silently
 *  drops the notification (useful for headless/test environments).
 *
 *  SECURITY: the `message` passed to `error()` (and `success()`) may contain
 *  server-controlled text — e.g. an HTTP error body's `error` field surfaced via
 *  ActionError.message, or a transport `r.error`. Render it as TEXT (textContent /
 *  a text node), never via innerHTML, to avoid reflected XSS from a malicious or
 *  compromised server response. */
export interface Notifier {
  success?(message: string): void;
  error?(message: string, retry?: NotifierRetry): void;
}

let _notifier: Notifier = {};
let _configured = false;
let _warnedUnconfigured = false;

/** Configure the global notifier adapter. Call once at app boot. Passing an
 *  empty object (`configure({})`) is the explicit headless opt-in: it keeps
 *  notifications silently dropped without the unconfigured-drop warning. */
export function configure(notifier: Notifier): void {
  _notifier = notifier;
  _configured = true;
}

/** Warn once, on the first notification dropped because configure() was
 *  never called — the silent-by-default footgun. An explicit configure()
 *  (even with missing methods) is a deliberate headless choice and stays
 *  silent, matching the documented Notifier contract. */
function warnUnconfiguredDrop(kind: string): void {
  if (_configured || _warnedUnconfigured) {
    return;
  }
  _warnedUnconfigured = true;
  console.warn(
    `[actions] ${kind} notification dropped — configure() was never called. Wire a notifier at boot, or call configure({}) for intentional headless silence. This warning fires once.`,
  );
}

/** @internal Emit a success notification. */
export function notifySuccess(message: string): void {
  if (_notifier.success === undefined) {
    warnUnconfiguredDrop("success");
    return;
  }
  _notifier.success(message);
}

/** @internal Emit an error notification. */
export function notifyError(message: string, retry?: NotifierRetry): void {
  if (_notifier.error === undefined) {
    warnUnconfiguredDrop("error");
    return;
  }
  _notifier.error(message, retry);
}

/** @internal Test-only: reset the notifier to the default no-op. */
export function _resetNotifierForTest(): void {
  _notifier = {};
  _configured = false;
  _warnedUnconfigured = false;
}
