// pollAction: repeat-an-action-on-interval primitive that integrates with
// the framework lifecycle. Adds pause-when-hidden, refresh-on-focus,
// exponential backoff on consecutive failures, and auto cleanup.
// ---------------------------------------------------------------------------

import { registerCleanup } from "./cleanup.js";
import type { Action } from "./types.js";

/** Configuration for {@link pollAction}. Controls interval timing,
 *  visibility-pause behavior, focus-refresh, and error backoff. */
export interface PollOptions<TResult = unknown> {
  /** Quiet window between polls in ms. */
  readonly interval: number;
  /** When true (default), polls pause while document.hidden === true. */
  readonly pauseWhenHidden?: boolean;
  /** When true (default), fire an immediate poll on window focus. */
  readonly refreshOnFocus?: boolean;
  /** Exponential backoff on consecutive failures. */
  readonly backoffOnError?: { readonly factor: number; readonly max: number };
  /** Per-poll success callback. */
  readonly onSuccess?: (result: TResult) => void;
}

/**
 * Repeatedly dispatch `action(args)` at the given interval.
 * Returns a `stop()` function.
 */
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
    if (typeof document === "undefined") {
      return;
    }
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

  registerCleanup(stop);

  if (!paused) {
    void tick();
  }

  return stop;
}
