import { createRoot, effect } from "@cplieger/reactive";

import { isPending, pendingCount } from "./registry.js";

/** Element types that have a `.disabled` writable boolean. */
type DisableableElement =
  HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

interface BindLoadingOptions {
  ariaBusy?: boolean;
  preserveAriaBusy?: boolean;
  pendingClass?: string;
  preserveDisabled?: boolean;
  disabledFn?: () => boolean;
}

/** Bind a button/input element's disabled / aria-busy state to one or more named actions.
 *  The binding ends, restoring the element, when the returned function is called
 *  or when the `@cplieger/reactive` owner it was created under is disposed. */
export function bindLoadingState(
  actionName: string | readonly string[],
  el: DisableableElement,
  opts: BindLoadingOptions = {},
): () => void {
  const names: readonly string[] = typeof actionName === "string" ? [actionName] : actionName;

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

  // An empty name list sums nothing, so this stays false for the binding's
  // whole life and the effect below never touches the element.
  const readPending = (): boolean =>
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the length-1 branch proves index 0
    names.length === 1 ? isPending(names[0]!) : pendingCount(names) > 0;

  const run = (dispose: () => void): void => {
    if (wasConnected && !el.isConnected) {
      dispose();
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

  let restoreOnDispose = true;
  return createRoot((dispose, owner) => {
    // Runs after the effect is released, so a signal write from restore's
    // focus() handler cannot re-run it. Self-release and the returned function
    // clear the flag: the first leaves the element as it is, the second
    // restores in the caller's context instead of this closing owner's.
    owner.onDispose(() => {
      if (restoreOnDispose) {
        restore();
      }
    });
    effect(() => {
      run(() => {
        restoreOnDispose = false;
        dispose();
      });
    });
    return () => {
      restoreOnDispose = false;
      dispose();
      restore();
    };
  });
}
