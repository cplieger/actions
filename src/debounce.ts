// debouncedDispatch: wrap an Action so that rapid calls coalesce into
// a single dispatch after a quiet window. Replaces ad-hoc setTimeout
// + clearTimeout chains with a single helper that adds flush/cancel.
// ---------------------------------------------------------------------------

import type { Action } from "./types.js";

/** A debounced action dispatcher. Callable to schedule a dispatch,
 *  with `flush`, `cancel`, and `isPending` control methods. */
export interface DebouncedDispatch<TArgs> {
  /** Schedule a dispatch with the given args. Replaces any pending
   *  dispatch's args. */
  (args: TArgs): void;

  /** Fire immediately with the most-recent args (or args supplied
   *  here, overriding the pending). No-op if nothing is pending and
   *  no args supplied. */
  flush(args?: TArgs): Promise<unknown> | undefined;

  /** Discard any pending dispatch without firing. */
  cancel(): void;

  /** True if there's a scheduled dispatch waiting for the timer. */
  isPending(): boolean;
}

interface DebounceOptions {
  /** Quiet window in ms. */
  readonly wait: number;
  /** Fire on the leading edge instead of the trailing edge. Default false. */
  readonly leading?: boolean;
}

/**
 * Wrap an action with a debounce timer so rapid calls coalesce into a
 * single dispatch after a quiet window.
 */
export function debouncedDispatch<TArgs, TResult>(
  action: Action<TArgs, TResult>,
  opts: DebounceOptions,
): DebouncedDispatch<TArgs> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: TArgs | undefined;
  let pending = false;
  let lastFiredAt = 0;

  const fn = ((args: TArgs): void => {
    if (opts.leading === true) {
      const now = Date.now();
      if (now - lastFiredAt < opts.wait) {
        lastArgs = args;
        pending = true;
        if (timer === undefined) {
          const remaining = Math.max(0, opts.wait - (now - lastFiredAt));
          timer = setTimeout(fireTrailing, remaining);
        }
        return;
      }
      void action.dispatch(args);
      lastFiredAt = now;
      lastArgs = undefined;
      pending = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(fireTrailing, opts.wait);
      return;
    }
    lastArgs = args;
    pending = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      pending = false;
      const a = lastArgs;
      lastArgs = undefined;
      if (a !== undefined) {
        void action.dispatch(a);
      }
    }, opts.wait);
  }) as DebouncedDispatch<TArgs>;

  function fireTrailing(): void {
    timer = undefined;
    const a = lastArgs;
    lastArgs = undefined;
    if (a !== undefined) {
      lastFiredAt = Date.now();
      pending = true;
      timer = setTimeout(fireTrailing, opts.wait);
      void action.dispatch(a);
    } else {
      pending = false;
    }
  }

  fn.flush = (args?: TArgs): Promise<unknown> | undefined => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const a = args ?? lastArgs;
    lastArgs = undefined;
    pending = false;
    if (a !== undefined) {
      if (opts.leading === true) {
        lastFiredAt = Date.now();
      }
      return action.dispatch(a);
    }
    return undefined;
  };

  fn.cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    lastArgs = undefined;
    pending = false;
  };

  fn.isPending = (): boolean => pending;

  return fn;
}
