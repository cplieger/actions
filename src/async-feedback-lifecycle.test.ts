// @vitest-environment happy-dom
// Cross-cycle bookkeeping for withAsyncFeedback: the live region is created
// once, a fresh cycle cancels the previous cycle's pending reset, the reset
// never touches a button that left the DOM, and a button removed mid-flight
// still releases the re-entry guard.
//
// Separate file from async-feedback.test.ts on purpose: the live-region
// singleton is module state, so pinning "created once" needs a module instance
// no other test has already announced through.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { withAsyncFeedback } from "./async-feedback.js";

function appendButton(label = "Save"): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  document.body.appendChild(btn);
  return btn;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("withAsyncFeedback — live region reuse", () => {
  it("announces two cycles through a single live region", async () => {
    const btn = appendButton();

    await withAsyncFeedback(btn, () => Promise.resolve(), { resetMs: 0 });
    vi.advanceTimersByTime(50);
    await withAsyncFeedback(btn, () => Promise.resolve(), { resetMs: 0 });
    vi.advanceTimersByTime(50);

    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  });
});

describe("withAsyncFeedback — stale reset from a previous cycle", () => {
  it("does not revert the button mid-cycle when the previous reset comes due", async () => {
    const btn = appendButton("Save");

    await withAsyncFeedback(btn, () => Promise.resolve());
    expect(btn.dataset["asyncStatus"]).toBe("success");

    vi.advanceTimersByTime(600);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const second = withAsyncFeedback(btn, () => gate);
    expect(btn.dataset["asyncStatus"]).toBe("pending");

    // The first cycle's reset was due at 1200ms. It must have been cancelled.
    vi.advanceTimersByTime(600);
    expect(btn.dataset["asyncStatus"]).toBe("pending");
    expect(btn.disabled).toBe(true);

    release();
    await second;
  });
});

describe("withAsyncFeedback — aria-busy restore", () => {
  it("puts back the button's original aria-busy value, not the pending one", async () => {
    const btn = appendButton();
    btn.setAttribute("aria-busy", "false");

    await withAsyncFeedback(btn, () => Promise.resolve());

    expect(btn.getAttribute("aria-busy")).toBe("false");
  });
});

describe("withAsyncFeedback — default (replace) pending content", () => {
  it("hides the button's label while pending", async () => {
    const btn = appendButton("Save");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const cycle = withAsyncFeedback(btn, () => gate);

    expect(btn.textContent).toBe("");
    expect(btn.querySelector(".btn-async-spinner")).not.toBeNull();

    release();
    await cycle;
  });
});

describe("withAsyncFeedback — button removed from the DOM", () => {
  it("releases the re-entry guard so a re-attached button can run again", async () => {
    const btn = appendButton();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const first = withAsyncFeedback(btn, () => gate);
    btn.remove();
    release();
    await first;

    document.body.appendChild(btn);
    await withAsyncFeedback(btn, () => Promise.resolve());

    expect(btn.dataset["asyncStatus"]).toBe("success");
  });

  it("leaves a detached button untouched when its reset comes due", async () => {
    const btn = appendButton("Save");

    await withAsyncFeedback(btn, () => Promise.resolve());
    expect(btn.dataset["asyncStatus"]).toBe("success");

    btn.remove();
    vi.advanceTimersByTime(1200);

    expect(btn.dataset["asyncStatus"]).toBe("success");
  });
});
