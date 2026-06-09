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
  /** Post-completion glyph hold in ms. Default 1200. */
  resetMs?: number;
  /** When true, prepend the spinner before the existing content (e.g.
   *  "⟳ Cloning…") instead of replacing the content with just the spinner.
   *  Default false (icon-only replace). */
  keepLabel?: boolean;
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
  // Guard: reject re-entry while any status is active (pending/success/error).
  if (btn.dataset["asyncStatus"] !== undefined) {
    return;
  }

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

  const origNodes = [...btn.childNodes].map((n) => n.cloneNode(true));
  const origDisabled = btn.disabled;
  const origAriaBusy = btn.getAttribute("aria-busy");

  btn.dataset["asyncStatus"] = "pending";
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  if (opts.keepLabel === true) {
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
    if (origAriaBusy === null) {
      btn.removeAttribute("aria-busy");
    } else {
      btn.setAttribute("aria-busy", origAriaBusy);
    }
    delete btn.dataset["asyncStatus"];
    return;
  }

  btn.dataset["asyncStatus"] = ok ? "success" : "error";
  btn.replaceChildren(ok ? renderSuccess() : renderError());
  if (origAriaBusy === null) {
    btn.removeAttribute("aria-busy");
  } else {
    btn.setAttribute("aria-busy", origAriaBusy);
  }
  if (announceCfg !== false) {
    announce(ok ? announceCfg.success : announceCfg.error);
  }

  const reset = opts.resetMs ?? RESET_MS;
  const timerId = setTimeout(() => {
    resetTimers.delete(btn);
    if (!btn.isConnected) {
      return;
    }
    btn.replaceChildren(...origNodes.map((n) => n.cloneNode(true)));
    btn.disabled = origDisabled;
    delete btn.dataset["asyncStatus"];
  }, reset);
  resetTimers.set(btn, timerId);
}
