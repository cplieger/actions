import { el } from "@cplieger/reactive";

const RESET_MS = 1200;

const DEFAULT_ANNOUNCE = { success: "Action completed", error: "Action failed" } as const;

const CHECK_HTML =
  '<svg class="btn-async-glyph" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

const X_HTML =
  '<svg class="btn-async-glyph" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="3" stroke-linecap="round" ' +
  'aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';

/** Parse a static SVG string via <template> and return a fresh clone. The
 *  markup is a library-controlled constant, so a single root element is
 *  guaranteed. */
function svgNode(svg: string): Node {
  const template = document.createElement("template");
  template.innerHTML = svg;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- default glyph markup always has a single root element
  return template.content.firstElementChild!.cloneNode(true);
}

const defaultRenderPending = (): Node =>
  el("span", { className: "spinner-sm btn-async-spinner", "aria-hidden": "true" });
const defaultRenderSuccess = (): Node => svgNode(CHECK_HTML);
const defaultRenderError = (): Node => svgNode(X_HTML);

const resetTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();

// Keyed on this, not `data-async-status`, so a persisted outcome glyph
// (resetMs<=0) can't permanently block re-dispatch.
const inFlight = new WeakSet<HTMLButtonElement>();

let liveRegion: HTMLElement | null = null;

function announce(message: string): void {
  if (liveRegion === null) {
    liveRegion = el("span", {
      className: "sr-only",
      "aria-live": "polite",
      "aria-atomic": "true",
    });
    document.body.appendChild(liveRegion);
  }
  const region = liveRegion;
  // Clear then set: re-announces an identical message.
  region.textContent = "";
  setTimeout(() => {
    region.textContent = message;
  }, 50);
}

/** Options for {@link withAsyncFeedback}. All fields are optional; the glyph
 *  renderers default to vibekit's inline SVGs. */
export interface AsyncFeedbackOptions {
  /** Post-completion glyph hold in ms before content reverts. Default 1200;
   *  `<= 0` persists the glyph indefinitely (button still re-enables, but
   *  `data-async-status` keeps its terminal value). */
  resetMs?: number;
  /** When true, prepend the spinner before the existing content (e.g.
   *  "⟳ Cloning…") instead of replacing the content with just the spinner.
   *  Default false (icon-only replace). Ignored when {@link target} is set. */
  keepLabel?: boolean;
  /** Drive a single child slot via element replacement
   *  (`current.replaceWith(next)`) instead of the button's whole content;
   *  other children of `btn` are untouched and the original node is restored
   *  on a non-persist reset. Expected to be a descendant of `btn` (not
   *  validated). `keepLabel` is ignored when set. */
  target?: HTMLElement;
  /** Pending-state node factory. Returns a fresh node per call. */
  renderPending?: () => Node;
  /** Success-glyph node factory. Returns a fresh node per call. */
  renderSuccess?: () => Node;
  /** Error-glyph node factory. Returns a fresh node per call. */
  renderError?: () => Node;
  /** Live-region announcement text, or `false` to disable announcing. */
  announce?: { readonly success: string; readonly error: string } | false;
}

/** Run an async function with consistent button feedback. The button is
 *  disabled during the call. Re-entrant calls (clicking again while a cycle
 *  is active) are ignored. */
export async function withAsyncFeedback(
  btn: HTMLButtonElement,
  fn: () => Promise<unknown>,
  opts: AsyncFeedbackOptions = {},
): Promise<void> {
  // `data-async-status` would deadlock the persist path, whose terminal
  // status is never cleared.
  if (inFlight.has(btn)) {
    return;
  }
  inFlight.add(btn);

  // Avoids a stale restore from a prior cycle.
  const prevTimer = resetTimers.get(btn);
  if (prevTimer !== undefined) {
    clearTimeout(prevTimer);
    resetTimers.delete(btn);
  }

  const renderPending = opts.renderPending ?? defaultRenderPending;
  const renderSuccess = opts.renderSuccess ?? defaultRenderSuccess;
  const renderError = opts.renderError ?? defaultRenderError;
  const announceCfg = opts.announce ?? DEFAULT_ANNOUNCE;

  // `originalTarget` keeps the exact node so a non-persist reset restores it;
  // `currentSlot` tracks whichever node currently occupies the slot.
  const target = opts.target;
  const useTarget = target !== undefined;
  const originalTarget: ChildNode | null = useTarget ? target : null;
  let currentSlot: ChildNode | null = useTarget ? target : null;

  // Render factories return Element/Text, both ChildNode at runtime.
  const swapSlot = (next: Node): void => {
    if (currentSlot === null) {
      return;
    }
    currentSlot.replaceWith(next);
    currentSlot = next as ChildNode;
  };

  const origNodes = useTarget ? [] : [...btn.childNodes].map((n) => n.cloneNode(true));
  const origDisabled = btn.disabled;
  const origAriaBusy = btn.getAttribute("aria-busy");
  // Captured before disabling: `btn.disabled = true` below blurs the button.
  const hadFocus = document.activeElement === btn;

  const restoreAriaBusy = (): void => {
    if (origAriaBusy === null) {
      btn.removeAttribute("aria-busy");
    } else {
      btn.setAttribute("aria-busy", origAriaBusy);
    }
  };

  // Only restores if focus has not since moved to a competing element.
  const restoreFocus = (): void => {
    if (hadFocus && btn.isConnected && !btn.disabled) {
      const active = document.activeElement;
      if (active === null || active === document.body) {
        btn.focus();
      }
    }
  };

  btn.dataset["asyncStatus"] = "pending";
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  if (useTarget) {
    swapSlot(renderPending());
  } else if (opts.keepLabel === true) {
    btn.prepend(renderPending(), document.createTextNode(" "));
  } else {
    btn.replaceChildren(renderPending());
  }

  let ok = true;
  try {
    await fn();
  } catch {
    ok = false;
  }

  // The async op may have removed btn from the DOM (e.g. a re-rendered list);
  // the new DOM already reflects the result.
  if (!btn.isConnected) {
    inFlight.delete(btn);
    restoreAriaBusy();
    delete btn.dataset["asyncStatus"];
    return;
  }

  btn.dataset["asyncStatus"] = ok ? "success" : "error";
  if (useTarget) {
    swapSlot(ok ? renderSuccess() : renderError());
  } else {
    btn.replaceChildren(ok ? renderSuccess() : renderError());
  }
  restoreAriaBusy();
  inFlight.delete(btn);
  if (announceCfg !== false) {
    announce(ok ? announceCfg.success : announceCfg.error);
  }

  // `resetMs <= 0` persists: no revert timer, but re-enable now since no
  // later callback will.
  const reset = opts.resetMs ?? RESET_MS;
  if (reset <= 0) {
    btn.disabled = origDisabled;
    restoreFocus();
    return;
  }

  const timerId = setTimeout(() => {
    resetTimers.delete(btn);
    if (!btn.isConnected) {
      return;
    }
    if (useTarget) {
      if (currentSlot !== null && originalTarget !== null) {
        currentSlot.replaceWith(originalTarget);
        currentSlot = originalTarget;
      }
    } else {
      btn.replaceChildren(...origNodes.map((n) => n.cloneNode(true)));
    }
    btn.disabled = origDisabled;
    restoreFocus();
    delete btn.dataset["asyncStatus"];
  }, reset);
  resetTimers.set(btn, timerId);
}
