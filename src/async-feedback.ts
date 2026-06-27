// withAsyncFeedback: per-button async feedback. Shows a spinner during the
// operation, a ✓ on success / ✗ on error, then reverts. Disables the button
// while pending and guards against re-entry.
//
// Works for both icon-only buttons (action pills) and text buttons. The
// button's original child nodes and disabled state are snapshotted and
// restored when the feedback cycle resets. State is exposed as
// `data-async-status` on the button so CSS or tests can observe it without
// parsing innerHTML.
//
// Promoted from vibekit's async-button.ts. The glyphs are injectable so apps
// with their own icon system (e.g. `<span class="icon icon-check">`) can reuse
// it; the defaults match vibekit's inline SVGs, making vibekit a zero-visual-
// change consumer.
// ---------------------------------------------------------------------------

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

/** WeakMap tracking the pending reset timer per button. */
const resetTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();

/** Tracks buttons with an in-flight operation. The re-entry guard keys on
 *  THIS (not `data-async-status`) so a persisted outcome glyph (resetMs<=0)
 *  does not permanently block a subsequent dispatch. */
const inFlight = new WeakSet<HTMLButtonElement>();

/** Lazily-created live region for announcing async-button outcomes. */
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
  // Clear then set to ensure re-announcement of identical messages.
  region.textContent = "";
  setTimeout(() => {
    region.textContent = message;
  }, 50);
}

/** Options for {@link withAsyncFeedback}. All fields are optional; the glyph
 *  renderers default to vibekit's inline SVGs. */
export interface AsyncFeedbackOptions {
  /** Post-completion glyph hold in ms before the content reverts. Default
   *  1200. A value of `0` (or any value `<= 0`) means *persist*: the content
   *  revert is never scheduled, so the success/error glyph stays in place
   *  indefinitely (a later caller-driven re-render is expected to clear it).
   *  Under persist the button is still re-enabled and `aria-busy` restored at
   *  outcome time, but `data-async-status` keeps its terminal `success`/
   *  `error` value (it is not cleared). Applies to both the whole-button and
   *  `target` paths. */
  resetMs?: number;
  /** When true, prepend the spinner before the existing content (e.g.
   *  "⟳ Cloning…") instead of replacing the content with just the spinner.
   *  Default false (icon-only replace). Ignored when {@link target} is set. */
  keepLabel?: boolean;
  /** Opt-in: drive a single child slot of the button instead of the button's
   *  whole content. When provided, the spinner / outcome glyph / reset cycle
   *  operates on `target` by REPLACING THE ELEMENT IN THE DOM
   *  (`current.replaceWith(next)`), leaving every other child of `btn` (e.g. a
   *  text label sibling) untouched. The original `target` node reference is
   *  kept so a (non-persist) reset restores that exact node. `target` is
   *  expected to be a descendant of `btn` (not hard-validated). The
   *  button-level concerns are unchanged: `disabled` toggle, the
   *  `data-async-status` re-entry guard, `aria-busy`, and the sr-only
   *  announce all still apply to `btn`. `keepLabel` is irrelevant here and is
   *  ignored. Default: whole-button (childNodes) mode. */
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
  // Guard: reject re-entry only while an operation is in flight. (Keying on
  // `data-async-status` would deadlock the persist path, whose terminal status
  // is intentionally never cleared.)
  if (inFlight.has(btn)) {
    return;
  }
  inFlight.add(btn);

  // Cancel any pending reset timer from a prior cycle to avoid stale restores.
  const prevTimer = resetTimers.get(btn);
  if (prevTimer !== undefined) {
    clearTimeout(prevTimer);
    resetTimers.delete(btn);
  }

  const renderPending = opts.renderPending ?? defaultRenderPending;
  const renderSuccess = opts.renderSuccess ?? defaultRenderSuccess;
  const renderError = opts.renderError ?? defaultRenderError;
  const announceCfg = opts.announce ?? DEFAULT_ANNOUNCE;

  // Target mode operates on a single child slot via element replacement and
  // never snapshots/replaces the button's own childNodes. `originalTarget`
  // keeps the exact node so a non-persist reset can restore it; `currentSlot`
  // tracks whichever node currently occupies the slot.
  const target = opts.target;
  const useTarget = target !== undefined;
  const originalTarget: ChildNode | null = useTarget ? target : null;
  let currentSlot: ChildNode | null = useTarget ? target : null;

  // Replace the live slot node with `next` and track it as the new slot.
  // Render factories return a single node (Element/Text), both of which are
  // ChildNode at runtime; the cast reflects that contract.
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
  // Capture focus BEFORE disabling: `btn.disabled = true` (below) blurs the
  // button, moving focus to <body>. We restore it once the button re-enables
  // so a keyboard user who activated it does not lose their place.
  const hadFocus = document.activeElement === btn;

  const restoreAriaBusy = (): void => {
    if (origAriaBusy === null) {
      btn.removeAttribute("aria-busy");
    } else {
      btn.setAttribute("aria-busy", origAriaBusy);
    }
  };

  // Restore keyboard focus to the button after it re-enables, but only if it
  // held focus before being disabled, is still connected and focusable, and
  // focus has not since moved to a competing element (activeElement is <body>
  // or null). Mirrors loading.ts's bindLoadingState/setIdle guard so the two
  // helpers behave consistently and neither steals focus the user moved away.
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

  // The button may have been removed from the DOM by the async operation
  // (e.g. a re-rendered list). Skip the success/error visual in that case —
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

  // `resetMs <= 0` => persist: skip the content-revert timer entirely. The
  // glyph stays and `data-async-status` keeps its terminal value, but the
  // button is re-enabled now (there is no reset callback to do it later).
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
