// @vitest-environment happy-dom
// Timing-boundary and teardown-bookkeeping rules that pollAction states but
// the rest of the suite does not pin: `backoffOnError.max` bounds a BACKED-OFF
// delay only — it must never shorten the quiet window between healthy polls —
// and stop() must release every subscription pollAction took out.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type * as CleanupModule from "./cleanup.js";

vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));

// A real-behaviour double over registerCleanup: the hook still lands in the
// real registry, but the unregister handle pollAction receives is observable,
// so "stop() releases its cleanup hook" can be asserted instead of assumed.
const cleanupProbe = vi.hoisted(() => ({ unregisters: [] as (() => void)[] }));
vi.mock("./cleanup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CleanupModule>();
  return {
    ...actual,
    registerCleanup: (fn: () => void): (() => void) => {
      const un = vi.fn(actual.registerCleanup(fn));
      cleanupProbe.unregisters.push(un);
      return un;
    },
  };
});

import { defineAction, _resetForTest as resetDefine } from "./define.js";
import { _resetForTest as resetRegistry } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";
import { pollAction } from "./poll.js";

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
  cleanupProbe.unregisters.length = 0;
  vi.clearAllMocks();
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pollAction — the backoff cap and the base interval are separate budgets", () => {
  it("keeps the configured interval between healthy polls even when the backoff cap is shorter", async () => {
    let count = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.cap_below_interval",
      run: () => Promise.resolve(++count),
    });

    vi.useFakeTimers();
    // max (250) deliberately BELOW interval (1000): the cap bounds the growth
    // applied after consecutive failures, so with zero failures the next poll
    // is due at the interval, never at the cap.
    const stop = pollAction(action, undefined, {
      interval: 1000,
      backoffOnError: { factor: 2, max: 250 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(count).toBe(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(count).toBe(1);

    await vi.advanceTimersByTimeAsync(750);
    expect(count).toBe(2);

    stop();
  });

  it("still caps a backed-off delay once a poll has failed", async () => {
    let calls = 0;
    const action = defineAction<undefined, number>({
      name: "test.poll.cap_applies_after_failure",
      error: false,
      run: () => {
        calls += 1;
        return Promise.reject(new Error("nope"));
      },
    });

    vi.useFakeTimers();
    const stop = pollAction(action, undefined, {
      interval: 1000,
      backoffOnError: { factor: 2, max: 250 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    // One failure recorded: the delay is min(1000 * 2, 250) = 250.
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toBe(2);

    stop();
  });
});

describe("pollAction — stop() releases everything start took out", () => {
  it("registers its document/window listeners against a signal stop() aborts, and releases its cleanup hook", async () => {
    const docAdd = vi.spyOn(document, "addEventListener");
    const winAdd = vi.spyOn(window, "addEventListener");

    const action = defineAction<undefined, number>({
      name: "test.poll.teardown",
      run: () => Promise.resolve(1),
    });

    vi.useFakeTimers();
    const stop = pollAction(action, undefined, { interval: 1000 });
    await vi.advanceTimersByTimeAsync(0);

    const visOpts = docAdd.mock.calls.find(([type]) => type === "visibilitychange")?.[2] as
      { signal?: AbortSignal } | undefined;
    const focusOpts = winAdd.mock.calls.find(([type]) => type === "focus")?.[2] as
      { signal?: AbortSignal } | undefined;

    // Both listeners must be scoped to an abort signal — that is the only thing
    // that detaches them, so a poller that outlives its page would leak.
    expect(visOpts?.signal).toBeInstanceOf(AbortSignal);
    expect(focusOpts?.signal).toBeInstanceOf(AbortSignal);
    expect(visOpts?.signal?.aborted).toBe(false);
    expect(focusOpts?.signal?.aborted).toBe(false);

    const unregister = cleanupProbe.unregisters.at(-1);
    expect(unregister).toBeDefined();
    expect(unregister).not.toHaveBeenCalled();

    stop();

    expect(visOpts?.signal?.aborted).toBe(true);
    expect(focusOpts?.signal?.aborted).toBe(true);
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});
