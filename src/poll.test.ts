import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));

import { defineAction, _resetForTest as resetDefine } from "./define.js";
import { _resetForTest as resetRegistry } from "./registry.js";
import { _resetForTest as resetCleanup, _cancelAllForTest as cancelAllForTest } from "./cleanup.js";
import { pollAction } from "./poll.js";

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
  vi.clearAllMocks();
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pollAction — basic scheduling", () => {
  it("dispatches immediately on start, then at the interval", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.basic",
      run: async () => ++count,
    });

    vi.useFakeTimers();
    const stop = pollAction(action, undefined, { interval: 1000 });

    await vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();
    expect(count).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(count).toBe(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(count).toBe(3);

    stop();
  });

  it("stop() cancels the next scheduled poll", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.stop",
      run: async () => ++count,
    });

    vi.useFakeTimers();
    const stop = pollAction(action, undefined, { interval: 100 });
    await Promise.resolve();
    expect(count).toBe(1);

    stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(count).toBe(1);
  });

  it("stop() is idempotent", () => {
    const action = defineAction<undefined, undefined>({
      name: "test.poll.idempotent",
      run: async () => undefined,
    });
    const stop = pollAction(action, undefined, { interval: 1000 });
    expect(() => {
      stop();
      stop();
      stop();
    }).not.toThrow();
  });
});

describe("pollAction — pauseWhenHidden", () => {
  it("pauses on visibilitychange to hidden, resumes on visible with immediate dispatch", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.hidden",
      run: async () => ++count,
    });

    vi.useFakeTimers();
    const stop = pollAction(action, undefined, { interval: 1000, pauseWhenHidden: true });
    await Promise.resolve();
    expect(count).toBe(1);

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(count).toBe(1);

    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    await Promise.resolve();
    expect(count).toBe(2);

    stop();
  });

  it("doesn't fire the first poll if started while hidden", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.start_hidden",
      run: async () => ++count,
    });

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    vi.useFakeTimers();
    const stop = pollAction(action, undefined, { interval: 1000, pauseWhenHidden: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(count).toBe(0);

    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(count).toBe(1);

    stop();
  });

  it("pauseWhenHidden: false keeps polling while hidden", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.always",
      run: async () => ++count,
    });

    vi.useFakeTimers();
    const stop = pollAction(action, undefined, { interval: 100, pauseWhenHidden: false });
    await Promise.resolve();

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(300);
    expect(count).toBeGreaterThan(1);

    stop();
  });
});

describe("pollAction — refreshOnFocus", () => {
  it("dispatches immediately on window focus", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.focus",
      run: async () => ++count,
    });

    vi.useFakeTimers();
    const stop = pollAction(action, undefined, { interval: 10_000, refreshOnFocus: true });

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(count).toBe(1);

    window.dispatchEvent(new Event("focus"));

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(count).toBe(2);

    stop();
  });

  it("refreshOnFocus: false ignores focus events", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.no_focus",
      run: async () => ++count,
    });

    vi.useFakeTimers();
    const stop = pollAction(action, undefined, { interval: 10_000, refreshOnFocus: false });

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(count).toBe(1);

    window.dispatchEvent(new Event("focus"));

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(count).toBe(1);

    stop();
  });
});

describe("pollAction — backoffOnError", () => {
  it("delays grow on consecutive failures", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.backoff",
      run: async () => {
        count++;
        throw new Error("fail");
      },
      error: false,
    });

    vi.useFakeTimers();
    const stop = pollAction(action, undefined, {
      interval: 100,
      backoffOnError: { factor: 2, max: 10_000 },
    });

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    const after1 = count;
    expect(after1).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(1500);
    expect(count).toBeGreaterThan(after1);
    expect(count).toBeLessThan(10);

    stop();
  });

  it("caps the delay at max", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.cap",
      run: async () => {
        count++;
        throw new Error("fail");
      },
      error: false,
    });

    vi.useFakeTimers();
    const stop = pollAction(action, undefined, {
      interval: 100,
      backoffOnError: { factor: 10, max: 500 },
    });

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(count).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(2500);
    expect(count).toBeGreaterThan(2);
    expect(count).toBeLessThan(8);

    stop();
  });

  it("resets to base interval after a successful poll", async () => {
    let fail = true;
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.reset",
      run: async () => {
        count++;
        if (fail) {
          throw new Error("fail");
        }
        return count;
      },
      error: false,
    });

    const stop = pollAction(action, undefined, {
      interval: 20,
      backoffOnError: { factor: 4, max: 10_000 },
    });

    await new Promise((r) => setTimeout(r, 200));
    const failedCount = count;
    expect(failedCount).toBeGreaterThanOrEqual(1);

    fail = false;
    await new Promise((r) => setTimeout(r, 400));
    const finalCount = count;
    expect(finalCount).toBeGreaterThan(failedCount);

    stop();
  });
});

describe("pollAction — onSuccess callback", () => {
  it("invokes onSuccess with the result on each successful dispatch", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.onSuccess",
      run: async () => ++count,
    });
    const onSuccess = vi.fn<(n: number) => void>();

    const stop = pollAction(action, undefined, {
      interval: 20,
      onSuccess,
      pauseWhenHidden: false,
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(onSuccess.mock.calls.length).toBeGreaterThan(1);
    expect(onSuccess.mock.calls[0]?.[0]).toBe(1);

    stop();
  });

  it("does not invoke onSuccess on failed dispatch", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.onSuccess_fail",
      run: async () => {
        count++;
        throw new Error("fail");
      },
      error: false,
    });
    const onSuccess = vi.fn<(n: number) => void>();

    const stop = pollAction(action, undefined, {
      interval: 20,
      onSuccess,
      pauseWhenHidden: false,
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(count).toBeGreaterThan(0);
    expect(onSuccess).not.toHaveBeenCalled();

    stop();
  });

  it("catches errors thrown by onSuccess and continues polling", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.onSuccess_throws",
      run: async () => ++count,
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onSuccess = vi.fn<(n: number) => void>(() => {
      throw new Error("kaboom");
    });

    const stop = pollAction(action, undefined, {
      interval: 20,
      onSuccess,
      pauseWhenHidden: false,
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(count).toBeGreaterThan(1);
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
    stop();
  });
});

describe("pollAction — cleanup integration", () => {
  it("auto-stops when registered cleanup fires (e.g. beforeunload)", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.cleanup",
      run: async () => ++count,
    });

    vi.useFakeTimers();
    pollAction(action, undefined, { interval: 100 });
    await Promise.resolve();
    expect(count).toBe(1);

    cancelAllForTest();

    await vi.advanceTimersByTimeAsync(500);
    expect(count).toBe(1);
  });
});

/** An action whose run() hangs until `settle()` is called, counting calls. */
function gatedAction(name: string) {
  let calls = 0;
  let release!: (n: number) => void;
  const action = defineAction<undefined, number>({
    name,
    run: () =>
      new Promise<number>((r) => {
        calls += 1;
        release = r;
      }),
  });
  return {
    action,
    calls: (): number => calls,
    settle: (): void => {
      release(1);
    },
  };
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
}

describe("pollAction — timer hygiene", () => {
  it("arms exactly one timer between polls", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.one_timer",
      run: async () => ++count,
    });

    vi.useFakeTimers();
    const stop = pollAction(action, undefined, { interval: 10_000 });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(count).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    stop();
  });

  it("replaces the armed timer when a focus refresh polls early", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.replace_timer",
      run: async () => ++count,
    });

    vi.useFakeTimers();
    const stop = pollAction(action, undefined, { interval: 10_000, refreshOnFocus: true });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    window.dispatchEvent(new Event("focus"));
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(count).toBe(2);
    // The interval timer that was already armed must be replaced, not joined.
    expect(vi.getTimerCount()).toBe(1);

    stop();
  });

  it("leaves no timer armed after stop()", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.stop_timer",
      run: async () => ++count,
    });

    vi.useFakeTimers();
    const stop = pollAction(action, undefined, { interval: 1000 });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer armed once the tab hides", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.hide_timer",
      run: async () => ++count,
    });

    vi.useFakeTimers();
    const stop = pollAction(action, undefined, { interval: 1000 });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(0);

    stop();
  });

  it("does not arm the next timer when the tab hid while a poll was in flight", async () => {
    const gated = gatedAction("test.poll.hide_midflight");

    vi.useFakeTimers();
    const stop = pollAction(gated.action, undefined, { interval: 1000 });
    await Promise.resolve();
    expect(gated.calls()).toBe(1);

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));

    gated.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);

    stop();
  });
});

describe("pollAction — overlap and teardown", () => {
  it("does not start a second poll when the tab returns while one is in flight", async () => {
    const gated = gatedAction("test.poll.no_overlap");

    vi.useFakeTimers();
    const stop = pollAction(gated.action, undefined, { interval: 1000 });
    await Promise.resolve();
    expect(gated.calls()).toBe(1);

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(gated.calls()).toBe(1);

    gated.settle();
    await vi.advanceTimersByTimeAsync(0);
    stop();
  });

  it("ignores a visibilitychange to visible when it was never paused", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.spurious_visible",
      run: async () => ++count,
    });

    vi.useFakeTimers();
    const stop = pollAction(action, undefined, { interval: 10_000 });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(count).toBe(1);

    document.dispatchEvent(new Event("visibilitychange"));
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(count).toBe(1);

    stop();
  });

  it("does not run onSuccess for a poll that resolves after stop()", async () => {
    let release!: (n: number) => void;
    const action = defineAction<undefined, number>({
      name: "test.poll.stop_midflight",
      run: () =>
        new Promise<number>((r) => {
          release = r;
        }),
    });
    const onSuccess = vi.fn<(n: number) => void>();

    vi.useFakeTimers();
    const stop = pollAction(action, undefined, { interval: 1000, onSuccess });
    await Promise.resolve();

    stop();
    release(7);
    await vi.advanceTimersByTimeAsync(0);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe("pollAction — hidden at start", () => {
  it("pauseWhenHidden: false polls even when it starts hidden", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.hidden_start_unpaused",
      run: async () => ++count,
    });

    setHidden(true);
    vi.useFakeTimers();
    const stop = pollAction(action, undefined, { interval: 1000, pauseWhenHidden: false });
    await Promise.resolve();
    expect(count).toBe(1);

    stop();
  });
});
