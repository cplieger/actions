/** Retry button descriptor passed to error notifications. */
export interface NotifierRetry {
  readonly onClick: () => void;
}

/** Consumer-provided notification adapter, wired via `configure()`. Both methods
 *  optional; unset ones drop silently.
 *
 *  SECURITY: `message` may carry server-controlled text (e.g. an HTTP error
 *  body's `error` field). Render as TEXT, never innerHTML — reflected XSS risk. */
export interface Notifier {
  success?(message: string): void;
  error?(message: string, retry?: NotifierRetry): void;
}

let _notifier: Notifier = {};
let _configured = false;
let _warnedUnconfigured = false;

/** Configure the global notifier adapter. `configure({})` is the explicit
 *  headless opt-in — silent, no unconfigured-drop warning. */
export function configure(notifier: Notifier): void {
  _notifier = notifier;
  _configured = true;
}

/** Warn once on the first notification dropped because configure() was never called. */
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
