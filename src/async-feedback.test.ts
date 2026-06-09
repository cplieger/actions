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
