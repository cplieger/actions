// pollAction outside a browser. Default (node) environment on purpose:
// `document` and `window` are undefined here, which is what the typeof guards
// around the visibilitychange / focus listener registration exist for. A
// happy-dom test can never reach those branches, so nothing else pins them.
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
