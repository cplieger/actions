import { registerCleanup } from "./cleanup.js";
import type { Action } from "./types.js";

/** Options for {@link pollAction}. `interval` is the gap between one poll
 *  settling and the next starting rather than a fixed cadence, so a slow action
 *  cannot queue polls behind itself. `backoffOnError` stretches that gap by
 *  `factor` per consecutive failure, capped at `max`; a failure means the
 *  dispatch resolved `null`, which is the only failure signal a poller gets
 *  because the action has already absorbed the error itself. `onSuccess` fires
 *  only for a non-null result, and a throw from it is logged rather than
 *  stopping the loop. */
export interface PollOptions<TResult = unknown> {
  readonly interval: number;
  /** Default true: pause while document.hidden. */
  readonly pauseWhenHidden?: boolean;
  /** Default true: fire an immediate poll on window focus. */
  readonly refreshOnFocus?: boolean;
  readonly backoffOnError?: { readonly factor: number; readonly max: number };
  readonly onSuccess?: (result: TResult) => void;
}

/** Start polling an action in the background and return its stop function.
 *
 *  Single-flight: a tick landing while a dispatch is still in flight is dropped
 *  rather than queued, focus-triggered polls included. The first poll runs
 *  immediately unless the document is already hidden, in which case it is
 *  deferred until the document is shown. `stop()` is idempotent, detaches both
 *  listeners, and also runs on page unload, so an unstopped poller does not
 *  survive navigation.
 *
 *  The pause-when-hidden and refresh-on-focus behaviour needs a DOM; where
 *  `document` or `window` is absent the loop degrades to a plain interval. */
export function pollAction<TArgs, TResult>(
  action: Action<TArgs, TResult>,
  args: TArgs,
  opts: PollOptions<TResult>,
): () => void {
  const pauseWhenHidden = opts.pauseWhenHidden !== false;
  const refreshOnFocus = opts.refreshOnFocus !== false;
  const baseInterval = opts.interval;
  const backoff = opts.backoffOnError;
  const onSuccess = opts.onSuccess;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let paused = false;
  let inFlight = false;
  let failures = 0;

  function nextDelay(): number {
    if (backoff === undefined || failures === 0) {
      return baseInterval;
    }
    return Math.min(baseInterval * Math.pow(backoff.factor, failures), backoff.max);
  }

  function schedule(): void {
    if (stopped || paused) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      void tick();
    }, nextDelay());
  }

  async function tick(): Promise<void> {
    if (stopped || paused) {
      return;
    }
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      const result = await action.dispatch(args);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- state changes during async
      if (stopped) {
        return;
      }
      if (result === null) {
        failures += 1;
      } else {
        failures = 0;
        if (onSuccess !== undefined) {
          try {
            onSuccess(result);
          } catch (e) {
            console.error("[pollAction] onSuccess threw", e);
          }
        }
      }
    } finally {
      inFlight = false;
    }
    schedule();
  }

  const onVisibility = (): void => {
    if (document.hidden) {
      paused = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    } else if (paused) {
      paused = false;
      void tick();
    }
  };

  const onFocus = (): void => {
    if (stopped || paused || inFlight) {
      return;
    }
    void tick();
  };

  function stop(): void {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    listenerCtrl.abort();
    unregisterCleanup();
  }

  const listenerCtrl = new AbortController();

  if (pauseWhenHidden && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility, { signal: listenerCtrl.signal });
    if (document.hidden) {
      paused = true;
    }
  }
  if (refreshOnFocus && typeof window !== "undefined") {
    window.addEventListener("focus", onFocus, { signal: listenerCtrl.signal });
  }

  const unregisterCleanup = registerCleanup(stop);

  if (!paused) {
    void tick();
  }

  return stop;
}
