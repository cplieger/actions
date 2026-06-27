// @vitest-environment happy-dom
// Tests for withAsyncFeedback — adapted from vibekit's async-button.test.ts,
// plus coverage for the injectable-glyph generalization.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { withAsyncFeedback } from "./async-feedback.js";

function makeButton(html = "Click me"): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.innerHTML = html;
  document.body.replaceChildren(btn);
  return btn;
}

// NOTE: this block runs first on purpose. The live region is lazily created
// once and appended to <body> (vibekit's exact behavior); a later makeButton()
// call replaces the body and detaches it. Asserting on it before any
// makeButton() eviction keeps the test independent of module-level state.
describe("withAsyncFeedback — live region announce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces the success message via an sr-only live region by default", async () => {
    const btn = document.createElement("button");
    btn.type = "button";
    document.body.appendChild(btn); // append, do not evict

    await withAsyncFeedback(btn, () => Promise.resolve());
    vi.advanceTimersByTime(50);

    const region = document.querySelector(".sr-only");
    expect(region).not.toBeNull();
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.getAttribute("aria-atomic")).toBe("true");
    expect(region?.textContent).toBe("Action completed");
    vi.advanceTimersByTime(1200);
  });
});

describe("withAsyncFeedback — default glyphs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows pending state immediately and disables the button", async () => {
    const btn = makeButton();
    let resolveFn: (() => void) | undefined;
    const work = new Promise<void>((res) => {
      resolveFn = res;
    });
    const promise = withAsyncFeedback(btn, () => work);

    expect(btn.dataset["asyncStatus"]).toBe("pending");
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.querySelector(".btn-async-spinner")).not.toBeNull();

    resolveFn!();
    await promise;
  });

  it("transitions to success when fn resolves; reverts after resetMs", async () => {
    const btn = makeButton("<span>Original</span>");
    await withAsyncFeedback(btn, () => Promise.resolve());

    expect(btn.dataset["asyncStatus"]).toBe("success");
    expect(btn.querySelector(".btn-async-glyph")).not.toBeNull();
    expect(btn.innerHTML).toContain("polyline");

    vi.advanceTimersByTime(1200);
    expect(btn.dataset["asyncStatus"]).toBeUndefined();
    expect(btn.disabled).toBe(false);
    expect(btn.innerHTML).toBe("<span>Original</span>");
    expect(btn.getAttribute("aria-busy")).toBeNull();
  });

  it("transitions to error when fn throws; reverts after resetMs", async () => {
    const btn = makeButton("Original");
    await withAsyncFeedback(btn, () => Promise.reject(new Error("fail")));

    expect(btn.dataset["asyncStatus"]).toBe("error");
    expect(btn.innerHTML).toContain("M18 6L6 18");

    vi.advanceTimersByTime(1200);
    expect(btn.dataset["asyncStatus"]).toBeUndefined();
    expect(btn.disabled).toBe(false);
    expect(btn.innerHTML).toBe("Original");
  });

  it("ignores re-entrant calls while pending", async () => {
    const btn = makeButton();
    const fn = vi.fn(() => new Promise<void>((res) => setTimeout(res, 100)));

    const first = withAsyncFeedback(btn, fn);
    const second = withAsyncFeedback(btn, fn);
    const third = withAsyncFeedback(btn, fn);

    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([first, second, third]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("preserves the original disabled state after reset", async () => {
    const btn = makeButton();
    btn.disabled = true; // started disabled
    await withAsyncFeedback(btn, () => Promise.resolve());
    vi.advanceTimersByTime(1200);
    expect(btn.disabled).toBe(true);
  });

  it("restores a pre-existing aria-busy attribute instead of removing it", async () => {
    const btn = makeButton();
    btn.setAttribute("aria-busy", "true");
    await withAsyncFeedback(btn, () => Promise.resolve());
    expect(btn.getAttribute("aria-busy")).toBe("true");
    vi.advanceTimersByTime(1200);
    expect(btn.getAttribute("aria-busy")).toBe("true");
  });

  it("respects a custom resetMs", async () => {
    const btn = makeButton();
    await withAsyncFeedback(btn, () => Promise.resolve(), { resetMs: 50 });
    expect(btn.dataset["asyncStatus"]).toBe("success");
    vi.advanceTimersByTime(49);
    expect(btn.dataset["asyncStatus"]).toBe("success");
    vi.advanceTimersByTime(2);
    expect(btn.dataset["asyncStatus"]).toBeUndefined();
  });

  it("with keepLabel renders the spinner alongside the original content", async () => {
    const btn = makeButton("Clone");
    let resolveFn: (() => void) | undefined;
    const work = new Promise<void>((res) => {
      resolveFn = res;
    });
    const promise = withAsyncFeedback(btn, () => work, { keepLabel: true });

    expect(btn.querySelector(".btn-async-spinner")).not.toBeNull();
    expect(btn.textContent).toContain("Clone");

    resolveFn!();
    await promise;
  });

  it("when the button is removed from the DOM mid-flight, no error and no glyph", async () => {
    const btn = makeButton();
    const work = Promise.resolve();
    btn.remove();
    await expect(withAsyncFeedback(btn, () => work)).resolves.toBeUndefined();
    expect(btn.dataset["asyncStatus"]).toBeUndefined();
    expect(btn.getAttribute("aria-busy")).toBeNull();
    expect(btn.querySelector(".btn-async-glyph")).toBeNull();
  });
});

describe("withAsyncFeedback — injectable glyphs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a custom renderSuccess when provided (default glyph not used)", async () => {
    const btn = makeButton();
    await withAsyncFeedback(btn, () => Promise.resolve(), {
      renderSuccess: () => {
        const s = document.createElement("span");
        s.className = "icon icon-check";
        return s;
      },
    });
    expect(btn.dataset["asyncStatus"]).toBe("success");
    expect(btn.querySelector(".icon-check")).not.toBeNull();
    expect(btn.querySelector(".btn-async-glyph")).toBeNull();
    vi.advanceTimersByTime(1200);
  });

  it("uses a custom renderError on rejection (default glyph not used)", async () => {
    const btn = makeButton();
    await withAsyncFeedback(btn, () => Promise.reject(new Error("x")), {
      renderError: () => {
        const s = document.createElement("span");
        s.className = "icon icon-close";
        return s;
      },
    });
    expect(btn.dataset["asyncStatus"]).toBe("error");
    expect(btn.querySelector(".icon-close")).not.toBeNull();
    expect(btn.querySelector(".btn-async-glyph")).toBeNull();
    vi.advanceTimersByTime(1200);
  });

  it("uses a custom renderPending node for the pending state", async () => {
    const btn = makeButton();
    let resolveFn: (() => void) | undefined;
    const work = new Promise<void>((res) => {
      resolveFn = res;
    });
    const promise = withAsyncFeedback(btn, () => work, {
      renderPending: () => {
        const s = document.createElement("span");
        s.className = "custom-spinner";
        return s;
      },
    });
    expect(btn.querySelector(".custom-spinner")).not.toBeNull();
    expect(btn.querySelector(".btn-async-spinner")).toBeNull();
    resolveFn!();
    await promise;
    vi.advanceTimersByTime(1200);
  });
});

describe("withAsyncFeedback — target slot + persist", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mk(cls: string): HTMLElement {
    const s = document.createElement("span");
    s.className = cls;
    return s;
  }

  function makeIconButton(): {
    btn: HTMLButtonElement;
    icon: HTMLSpanElement;
    label: HTMLSpanElement;
  } {
    const btn = document.createElement("button");
    btn.type = "button";
    const icon = document.createElement("span");
    icon.className = "icon";
    const label = document.createElement("span");
    label.textContent = " Label";
    btn.append(icon, label);
    document.body.replaceChildren(btn);
    return { btn, icon, label };
  }

  // (a) target mode: only the slot animates; the label sibling is untouched;
  // the ORIGINAL slot node (same reference) is restored on default reset.
  it("replaces only the target slot, preserves the label, restores the original slot on reset", async () => {
    const { btn, icon, label } = makeIconButton();
    let resolveFn: (() => void) | undefined;
    const work = new Promise<void>((res) => {
      resolveFn = res;
    });
    const promise = withAsyncFeedback(btn, () => work, {
      target: icon,
      renderPending: () => mk("pending-slot"),
      renderSuccess: () => mk("success-slot"),
    });

    // Pending: the icon slot is swapped out for the pending node; label intact.
    expect(btn.querySelector(".pending-slot")).not.toBeNull();
    expect(btn.contains(icon)).toBe(false);
    expect(btn.contains(label)).toBe(true);
    expect(label.textContent).toBe(" Label");
    expect(btn.children.length).toBe(2);
    expect(btn.dataset["asyncStatus"]).toBe("pending");

    resolveFn!();
    await promise;

    // Success: pending node swapped for success node; label still present.
    expect(btn.querySelector(".success-slot")).not.toBeNull();
    expect(btn.querySelector(".pending-slot")).toBeNull();
    expect(btn.contains(label)).toBe(true);
    expect(btn.children.length).toBe(2);
    expect(btn.dataset["asyncStatus"]).toBe("success");

    vi.advanceTimersByTime(1200);

    // Reset: the EXACT original icon node is restored (identity), not a clone.
    expect(btn.children[0]).toBe(icon);
    expect(btn.contains(icon)).toBe(true);
    expect(btn.querySelector(".success-slot")).toBeNull();
    expect(btn.contains(label)).toBe(true);
    expect(btn.dataset["asyncStatus"]).toBeUndefined();
    expect(btn.disabled).toBe(false);
  });

  // (b) target + resetMs:0 — persist the outcome glyph; button re-enabled.
  it("target + resetMs:0 persists the outcome glyph and re-enables the button", async () => {
    const { btn, icon, label } = makeIconButton();
    await withAsyncFeedback(btn, () => Promise.resolve(), {
      target: icon,
      resetMs: 0,
      renderSuccess: () => mk("success-slot"),
    });

    expect(btn.dataset["asyncStatus"]).toBe("success");
    expect(btn.querySelector(".success-slot")).not.toBeNull();
    expect(btn.disabled).toBe(false);

    // No revert timer was scheduled: advancing time changes nothing.
    vi.advanceTimersByTime(5000);
    expect(btn.querySelector(".success-slot")).not.toBeNull();
    expect(btn.contains(icon)).toBe(false);
    expect(btn.contains(label)).toBe(true);
    expect(btn.dataset["asyncStatus"]).toBe("success");
  });

  // (c) error path in target mode -> renderError node.
  it("target mode error path swaps in the error node", async () => {
    const { btn, icon } = makeIconButton();
    await withAsyncFeedback(btn, () => Promise.reject(new Error("nope")), {
      target: icon,
      renderError: () => mk("error-slot"),
      renderSuccess: () => mk("success-slot"),
    });

    expect(btn.dataset["asyncStatus"]).toBe("error");
    expect(btn.querySelector(".error-slot")).not.toBeNull();
    expect(btn.querySelector(".success-slot")).toBeNull();

    vi.advanceTimersByTime(1200);
    expect(btn.contains(icon)).toBe(true);
    expect(btn.querySelector(".error-slot")).toBeNull();
    expect(btn.dataset["asyncStatus"]).toBeUndefined();
  });

  // (d) persist on the WHOLE-BUTTON path (resetMs:0, no target).
  it("resetMs:0 on the whole-button path persists the glyph (no revert)", async () => {
    const btn = makeButton("<span>Original</span>");
    await withAsyncFeedback(btn, () => Promise.resolve(), { resetMs: 0 });

    expect(btn.dataset["asyncStatus"]).toBe("success");
    expect(btn.querySelector(".btn-async-glyph")).not.toBeNull();
    expect(btn.disabled).toBe(false);

    vi.advanceTimersByTime(5000);
    expect(btn.querySelector(".btn-async-glyph")).not.toBeNull();
    expect(btn.innerHTML).not.toContain("Original");
    expect(btn.dataset["asyncStatus"]).toBe("success");
  });

  // (e) re-entry guard in target mode: second call while pending is a no-op.
  it("rejects re-entry while pending in target mode (fn once, no double swap)", async () => {
    const { btn, icon } = makeIconButton();
    const fn = vi.fn(() => new Promise<void>((res) => setTimeout(res, 100)));

    const first = withAsyncFeedback(btn, fn, {
      target: icon,
      renderPending: () => mk("pending-slot"),
    });
    const second = withAsyncFeedback(btn, fn, {
      target: icon,
      renderPending: () => mk("pending-slot"),
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(btn.querySelectorAll(".pending-slot").length).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([first, second]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // (f) REGRESSION GUARD: whole-button default path is unchanged — single
  // glyph via replaceChildren, disabled held through the glyph hold, content
  // and disabled both restored at the default 1200ms reset.
  it("regression: whole-button default path still replaceChildren + reverts", async () => {
    const btn = makeButton("<span>Original</span>");
    await withAsyncFeedback(btn, () => Promise.resolve(), {
      renderSuccess: () => mk("success-slot"),
    });

    expect(btn.children.length).toBe(1);
    expect(btn.querySelector(".success-slot")).not.toBeNull();
    expect(btn.textContent).not.toContain("Original");
    expect(btn.dataset["asyncStatus"]).toBe("success");
    // Default path keeps the button disabled during the glyph hold (it is
    // re-enabled only at reset) — this is the unchanged behavior persist diverges from.
    expect(btn.disabled).toBe(true);

    vi.advanceTimersByTime(1200);
    expect(btn.innerHTML).toBe("<span>Original</span>");
    expect(btn.disabled).toBe(false);
    expect(btn.dataset["asyncStatus"]).toBeUndefined();
  });

  it("persist (resetMs:0) re-enables the button and allows a subsequent dispatch", async () => {
    const btn = document.createElement("button");
    document.body.append(btn);
    let runs = 0;
    await withAsyncFeedback(
      btn,
      async () => {
        runs += 1;
      },
      { resetMs: 0 },
    );
    expect(runs).toBe(1);
    expect(btn.disabled).toBe(false);
    expect(btn.dataset["asyncStatus"]).toBe("success");
    await withAsyncFeedback(
      btn,
      async () => {
        runs += 1;
      },
      { resetMs: 0 },
    );
    expect(runs).toBe(2);
    btn.remove();
  });
});

describe("withAsyncFeedback — focus restore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // happy-dom does not blur an element when it becomes disabled, and ignores
  // blur() on a disabled element — unlike a real browser, which drops focus to
  // <body> the moment the button is disabled. Emulate that drop by parking
  // focus on a throwaway enabled input and blurring it, which lands
  // document.activeElement at null (one of the states the guard restores from).
  function dropFocus(): void {
    const sink = document.createElement("input");
    document.body.appendChild(sink);
    sink.focus();
    sink.blur();
    sink.remove();
  }

  // A keyboard user activates the button; disabling it during the async cycle
  // drops focus away from it. When the timed reset re-enables the button,
  // focus must return so the user does not lose their place.
  it("restores focus to a focused button after the timed reset re-enables it", async () => {
    const btn = makeButton();
    btn.focus();
    expect(document.activeElement).toBe(btn);

    let resolveFn: (() => void) | undefined;
    const work = new Promise<void>((res) => {
      resolveFn = res;
    });
    const promise = withAsyncFeedback(btn, () => work);

    // Simulate the disable dropping focus off the button.
    dropFocus();
    expect(document.activeElement).not.toBe(btn);

    resolveFn!();
    await promise;

    // Outcome glyph is showing; the default path keeps the button disabled
    // until the reset timer fires.
    expect(btn.disabled).toBe(true);

    vi.advanceTimersByTime(1200);
    expect(btn.disabled).toBe(false);
    expect(document.activeElement).toBe(btn);
  });

  // The persist path (resetMs <= 0) re-enables the button at outcome time
  // rather than via a timer, so focus restore must happen there too.
  it("restores focus via the persist path (resetMs:0)", async () => {
    const btn = makeButton();
    btn.focus();

    let resolveFn: (() => void) | undefined;
    const work = new Promise<void>((res) => {
      resolveFn = res;
    });
    const promise = withAsyncFeedback(btn, () => work, { resetMs: 0 });

    dropFocus();
    expect(document.activeElement).not.toBe(btn);

    resolveFn!();
    await promise;

    expect(btn.disabled).toBe(false);
    expect(document.activeElement).toBe(btn);
  });

  // Guard: if the user moves focus to a competing element while the operation
  // is in flight, the reset must NOT yank focus back to the button.
  it("does not steal focus back when it moved to another element during the cycle", async () => {
    const btn = makeButton();
    const other = document.createElement("input");
    document.body.appendChild(other);
    btn.focus();
    expect(document.activeElement).toBe(btn);

    let resolveFn: (() => void) | undefined;
    const work = new Promise<void>((res) => {
      resolveFn = res;
    });
    const promise = withAsyncFeedback(btn, () => work);

    // User tabs/clicks into another field mid-flight.
    other.focus();
    expect(document.activeElement).toBe(other);

    resolveFn!();
    await promise;
    vi.advanceTimersByTime(1200);

    // Focus stays on the element the user moved to.
    expect(document.activeElement).toBe(other);
    expect(btn.disabled).toBe(false);
  });

  // A button that did NOT have focus when the cycle started must not gain
  // focus when it re-enables.
  it("does not grab focus for a button that was never focused", async () => {
    const btn = makeButton();
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    expect(document.activeElement).toBe(other);

    await withAsyncFeedback(btn, () => Promise.resolve());
    vi.advanceTimersByTime(1200);

    expect(document.activeElement).toBe(other);
    expect(btn.disabled).toBe(false);
  });

  it("does not grab focus when never focused even if nothing else holds focus", async () => {
    // Isolates the `hadFocus` guard: nothing holds focus, so
    // document.activeElement is <body> — a restore-eligible state, so only the
    // hadFocus check stops the button stealing focus on completion. (The sibling
    // "moved to another element" test cannot isolate this: there the activeElement
    // check blocks restore regardless of hadFocus.)
    const btn = makeButton();
    expect(document.activeElement).toBe(document.body);

    await withAsyncFeedback(btn, () => Promise.resolve());
    vi.advanceTimersByTime(1200);

    expect(btn.disabled).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
});
