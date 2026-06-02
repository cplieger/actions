// bindLoadingState: bind a button or input element's disabled / aria-busy
// state to one or more named actions' pending count.
//
// While ANY of the named actions is pending, the element gets:
//   - disabled = true
//   - aria-busy = "true"  (omit by passing { ariaBusy: false })
//   - optionally an extra CSS class via { pendingClass: "btn-loading" }
//
// Returns an unsubscribe function. Call it from the view's teardown
// hook to stop receiving updates and avoid leaking listeners.
// ---------------------------------------------------------------------------

import { subscribeByName, isPending, pendingCount } from "./registry.js";

/** Element types that have a `.disabled` writable boolean. */
type DisableableElement =
  | HTMLButtonElement
  | HTMLInputElement
  | HTMLSelectElement
  | HTMLTextAreaElement;

interface BindLoadingOptions {
  ariaBusy?: boolean;
  preserveAriaBusy?: boolean;
  pendingClass?: string;
  preserveDisabled?: boolean;
  disabledFn?: () => boolean;
}

/**
 * Bind a button/input element's disabled / aria-busy state to one or
 * more named actions.
 */
export function bindLoadingState(
  actionName: string | readonly string[],
  el: DisableableElement,
  opts: BindLoadingOptions = {},
): () => void {
  const names: readonly string[] = typeof actionName === "string" ? [actionName] : actionName;
  if (names.length === 0) {
    return () => {
      /* noop */
    };
  }

  const {
    ariaBusy = true,
    preserveAriaBusy = false,
    pendingClass,
    preserveDisabled = false,
    disabledFn,
  } = opts;
  const manageAriaBusy = ariaBusy && !preserveAriaBusy;
  let wasPending = false;
  let baseDisabled = el.disabled;
  let hadFocus = false;
  let disposed = false;
  let wasConnected = el.isConnected;

  const resolveBase = (): boolean => {
    if (disabledFn !== undefined) {
      try {
        return disabledFn();
      } catch {
        return false;
      }
    }
    return preserveDisabled ? baseDisabled : false;
  };

  const setIdle = (): void => {
    el.disabled = resolveBase();
    if (manageAriaBusy) {
      el.removeAttribute("aria-busy");
    }
    if (pendingClass) {
      el.classList.remove(pendingClass);
    }
    if (hadFocus && el.isConnected && !el.disabled) {
      const active = document.activeElement;
      if (active === null || active === document.body) {
        el.focus();
      }
    }
    hadFocus = false;
  };

  const readPending = (): boolean =>
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length checked above
    names.length === 1 ? isPending(names[0]!) : pendingCount(names) > 0;

  // eslint-disable-next-line prefer-const -- assigned after apply() closure is defined
  let _unsubs: (() => void)[] | undefined;

  const apply = (): void => {
    if (disposed) {
      return;
    }
    if (wasConnected && !el.isConnected) {
      disposed = true;
      if (_unsubs) {
        for (const u of _unsubs) {
          u();
        }
      }
      return;
    }
    if (el.isConnected) {
      wasConnected = true;
    }
    const pending = readPending();
    if (pending && !wasPending) {
      baseDisabled = el.disabled;
      hadFocus = document.activeElement === el;
    }
    if (pending) {
      el.disabled = true;
      if (manageAriaBusy) {
        el.setAttribute("aria-busy", "true");
      }
      if (pendingClass) {
        el.classList.add(pendingClass);
      }
    } else if (wasPending) {
      setIdle();
    }
    wasPending = pending;
  };

  const restore = (): void => {
    if (wasPending) {
      setIdle();
      wasPending = false;
    }
  };

  apply();

  const unsubs = names.map((name) => subscribeByName(name, apply));
  _unsubs = unsubs;

  return () => {
    disposed = true;
    restore();
    for (const u of unsubs) {
      u();
    }
  };
}
