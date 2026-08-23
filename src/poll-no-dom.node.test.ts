// pollAction outside a browser.
//
// The `.node.test.ts` suffix is what puts this file in the node project, and it
// is load-bearing: `document` and `window` must be UNDEFINED here, which is what
// the typeof guards around the visibilitychange / focus listener registration
// exist for. Every sibling test runs in a real Chromium where those globals
// always exist, so those branches are unreachable there and nothing else pins
// them. Moved into the browser project this file would not fail; it would pass
// vacuously, having taken the arm it was written to avoid.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));

import { defineAction, _resetForTest as resetDefine } from "./define.js";
import { _resetForTest as resetRegistry } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";
import { pollAction } from "./poll.js";

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pollAction — no DOM", () => {
  it("polls on the interval without a document or a window", async () => {
    expect(typeof document).toBe("undefined");
    expect(typeof window).toBe("undefined");

    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.nodom",
      run: async () => ++count,
    });

    vi.useFakeTimers();
    const stop = pollAction(action, undefined, { interval: 1000 });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(count).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(count).toBe(2);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(count).toBe(2);
  });
});
