// Chromium never yields activeElement === null (existing tests cover the
// document.body arm), so this file installs that state to assert the guard's
// otherwise-unreachable-in-browser first arm.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { withAsyncFeedback } from "./async-feedback.js";

function makeButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Save";
  document.body.replaceChildren(btn);
  return btn;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document as unknown as Record<string, unknown>, "activeElement");
  vi.restoreAllMocks();
});

describe("withAsyncFeedback — focus restore when nothing holds focus", () => {
  it("returns focus to the button when activeElement is null at reset time", async () => {
    const btn = makeButton();
    btn.focus();
    expect(document.activeElement).toBe(btn);

    const focusSpy = vi.spyOn(btn, "focus");
    let finish: (() => void) | undefined;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cycle = withAsyncFeedback(btn, () => work, { resetMs: 0 });

    Object.defineProperty(document, "activeElement", { value: null, configurable: true });
    focusSpy.mockClear();

    finish?.();
    await cycle;

    expect(btn.disabled).toBe(false);
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it("does not return focus when another element claimed it", async () => {
    const btn = makeButton();
    const other = document.createElement("input");
    document.body.append(other);
    btn.focus();

    const focusSpy = vi.spyOn(btn, "focus");
    let finish: (() => void) | undefined;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cycle = withAsyncFeedback(btn, () => work, { resetMs: 0 });

    other.focus();
    focusSpy.mockClear();

    finish?.();
    await cycle;

    expect(focusSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(other);
  });
});
