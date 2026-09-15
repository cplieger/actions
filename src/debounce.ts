import type { Action } from "./types.js";

// A no-argument action's args ARE `undefined`, so it can't double as the
// empty-state marker; this sentinel is module-private and unforgeable as TArgs.
const NO_ARGS = Symbol("debounce.noArgs");

/** The callable {@link debouncedDispatch} returns: invoking it schedules a
 *  dispatch rather than performing one (except under `leading: true`, where the
 *  call that opens a window dispatches immediately), and the extra members
 *  drive whatever is currently scheduled. Only `flush` hands back the action's
 *  promise — every other path drops it, so results and errors are observed
 *  through the action's own notifications and callbacks. */
export interface DebouncedDispatch<TArgs> {
  /** Replaces any pending dispatch's args. */
  (args: TArgs): void;

  /** Fires immediately with the most-recent args, or the args given here.
   *  No-op if nothing is pending and no args supplied. */
  flush(args?: TArgs): Promise<unknown> | undefined;

  cancel(): void;

  isPending(): boolean;
}

interface DebounceOptions {
  readonly wait: number;
  /** Default false (trailing edge). */
  readonly leading?: boolean;
}

/** Wrap an action so a burst of calls collapses into one dispatch per `wait`
 *  window — the search-as-you-type case.
 *
 *  Trailing edge by default: every call restarts the timer and the last args
 *  win, so a caller typing faster than `wait` never dispatches at all until it
 *  pauses. With `leading: true` the first call dispatches immediately and calls
 *  inside the window are held for a single trailing fire as it closes. There is
 *  deliberately no `maxWait`; a caller that needs a guaranteed fire calls
 *  `flush()`.
 *
 *  `cancel()` discards scheduled args only. A dispatch already handed to the
 *  action is past this wrapper's reach — abort it through the action or its
 *  dispatch handle. */
export function debouncedDispatch<TArgs, TResult>(
  action: Action<TArgs, TResult>,
  opts: DebounceOptions,
): DebouncedDispatch<TArgs> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: TArgs | typeof NO_ARGS = NO_ARGS;
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
      lastArgs = NO_ARGS;
      // The timer below is a cooldown re-arm, not a pending dispatch.
      pending = false;
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
      lastArgs = NO_ARGS;
      if (a !== NO_ARGS) {
        void action.dispatch(a);
      }
    }, opts.wait);
  }) as DebouncedDispatch<TArgs>;

  function fireTrailing(): void {
    timer = undefined;
    const a = lastArgs;
    lastArgs = NO_ARGS;
    if (a !== NO_ARGS) {
      lastFiredAt = Date.now();
      pending = false;
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
    lastArgs = NO_ARGS;
    pending = false;
    if (a !== NO_ARGS) {
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
    lastArgs = NO_ARGS;
    pending = false;
  };

  fn.isPending = (): boolean => pending;

  return fn;
}
