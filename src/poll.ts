// pollAction: repeat-an-action-on-interval primitive.
// ---------------------------------------------------------------------------

import { registerCleanup } from "./cleanup.js";
import type { Action } from "./types.js";

export interface PollOptions<TResult = unknown> {
  readonly interval: number;
  readonly pauseWhenHidden?: boolean;
  readonly refreshOnFocus?: boolean;
  readonly backoffOnError?: { readonly factor: number; readonly max: number };
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
