import type { Action } from "./types.js";

// A no-argument action's args ARE `undefined`, so it can't double as the
// empty-state marker; this sentinel is module-private and unforgeable as TArgs.
const NO_ARGS = Symbol("debounce.noArgs");

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
