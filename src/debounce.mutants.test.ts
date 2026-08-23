// @vitest-environment happy-dom
// The leading-edge cooldown's terminal state. `fireTrailing` is reached with
// nothing coalesced whenever the quiet window closes on an empty queue, and it
// must land `isPending()` back on false in BOTH of its arms — otherwise a
// caller polling isPending() sees a dispatcher that is permanently "busy".
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
import { debouncedDispatch } from "./debounce.js";

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
  vi.useFakeTimers();
  // lastFiredAt starts at 0, so the clock must be past `wait` for the first
  // call to be treated as a leading edge rather than as being inside a window.
  vi.setSystemTime(new Date(1_000_000));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("debouncedDispatch — leading edge, cooldown with nothing queued", () => {
  it("clears the pending flag when the coalesced call carried undefined args", async () => {
    const run = vi.fn(() => Promise.resolve("ok"));
    const action = defineAction<undefined, string>({
      name: "test.debounce.undefined_args",
      run,
    });
    const debounced = debouncedDispatch<undefined, string>(action, { wait: 100, leading: true });

    debounced(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(debounced.isPending()).toBe(false);

    // Inside the quiet window: the call is coalesced onto the trailing timer.
    debounced(undefined);
    expect(debounced.isPending()).toBe(true);

    await vi.advanceTimersByTimeAsync(100);

    // The window closed. Whether or not the coalesced args were dispatchable,
    // nothing is scheduled any more, so the dispatcher is not pending.
    expect(debounced.isPending()).toBe(false);
  });

  it("clears the pending flag when the window closes after a cancel emptied the queue", async () => {
    const run = vi.fn((args: string) => Promise.resolve(args));
    const action = defineAction<string, string>({
      name: "test.debounce.cancelled_queue",
      run,
    });
    const debounced = debouncedDispatch(action, { wait: 100, leading: true });

    debounced("first");
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(debounced.isPending()).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
