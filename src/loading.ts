// bindLoadingState: bind a button or input element's disabled / aria-busy
// state to one or more named actions' pending state.
//
// While ANY of the named actions is pending, the element gets:
//   - disabled = true
//   - aria-busy = "true"  (omit by passing { ariaBusy: false })
//   - optionally an extra CSS class via { pendingClass: "btn-loading" }
//
// Implemented as a reactive effect over the registry's pending signals: it
// re-runs automatically whenever a bound action's pending state changes, so
// there is no bespoke subscription here. Returns a dispose function — call it
// from the view's teardown hook to stop updates and release the element.
// ---------------------------------------------------------------------------

import { effect } from "@cplieger/reactive";

import { isPending, pendingCount } from "./registry.js";

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
  // Holder so run() can self-dispose the effect on detach without a
  // forward-referenced `let` (assigned just below, after run() is defined).
  const handle: { dispose?: () => void } = {};

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

  // Reactive effect: readPending() tracks the registry's pending signals, so
  // this re-runs whenever a bound action's pending state changes.
  const run = (): undefined => {
    if (disposed) {
      return undefined;
    }
    if (wasConnected && !el.isConnected) {
      // Element left the DOM without an explicit unbind — auto-dispose so we
      // don't keep it (and the effect) alive. Defer the dispose: `dispose` is
      // still unset during the effect's own first synchronous run.
      disposed = true;
      queueMicrotask(() => handle.dispose?.());
      return undefined;
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
    return undefined;
  };

  const restore = (): void => {
    if (wasPending) {
      setIdle();
      wasPending = false;
    }
  };

  handle.dispose = effect(run);

  return () => {
    disposed = true;
    restore();
    handle.dispose?.();
  };
}
