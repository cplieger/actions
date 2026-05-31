// debouncedDispatch: wrap an Action so that rapid calls coalesce into
// a single dispatch after a quiet window.
// ---------------------------------------------------------------------------

import type { Action } from "./types.js";

export interface DebouncedDispatch<TArgs> {
  (args: TArgs): void;
  flush(args?: TArgs): Promise<unknown> | undefined;
  cancel(): void;
  isPending(): boolean;
}

interface DebounceOptions {
  readonly wait: number;
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
