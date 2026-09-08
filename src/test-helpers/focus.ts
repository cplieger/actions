/**
 * Internal test helper for the browser's own focus moves.
 */

/**
 * Resolves when the browser fires `blur` on `el`.
 *
 * Chromium 153 stopped blurring a form control synchronously with the
 * `disabled` write (https://issues.chromium.org/issues/519062393) and queues
 * the focus move instead, on a task later than a `MessageChannel` task, so the
 * event is the only reliable signal. Attach BEFORE the disabling write:
 * Chromium 152 and earlier fire the blur from inside it.
 */
export function blurredOff(el: HTMLElement): Promise<void> {
  return new Promise<void>((resolve) => {
    el.addEventListener(
      "blur",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}
