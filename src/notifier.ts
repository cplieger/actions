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
 *  drops the notification (useful for headless/test environments). */
export interface Notifier {
  success?(message: string): void;
  error?(message: string, retry?: NotifierRetry): void;
}

let _notifier: Notifier = {};

/** Configure the global notifier adapter. Call once at app boot. */
export function configure(notifier: Notifier): void {
  _notifier = notifier;
}

/** @internal Emit a success notification. */
export function notifySuccess(message: string): void {
  _notifier.success?.(message);
}

/** @internal Emit an error notification. */
export function notifyError(message: string, retry?: NotifierRetry): void {
  _notifier.error?.(message, retry);
}

/** @internal Test-only: reset the notifier to the default no-op. */
export function _resetNotifierForTest(): void {
  _notifier = {};
}
