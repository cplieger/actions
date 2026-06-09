// Tests for pollUntil — the poll-until-terminal helper.
import { describe, it, expect, vi, afterEach } from "vitest";

import { pollUntil } from "./poll-until.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pollUntil — terminal predicate", () => {
  it("resolves done on the first terminal poll", async () => {
    vi.useFakeTimers();
    const step = vi.fn(async () => ({ status: "complete" }));

    const p = pollUntil(step, {
      intervalMs: 100,
      until: (r) => r.status === "complete",
    });

    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toEqual({ status: "done", result: { status: "complete" } });
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through non-terminal results and calls onPoll", async () => {
    vi.useFakeTimers();
    let n = 0;
    const onPoll = vi.fn();
    const step = vi.fn(async () => ({ n: ++n }));

    const p = pollUntil(step, {
      intervalMs: 100,
      until: (r) => r.n >= 3,
      onPoll,
    });

    await vi.advanceTimersByTimeAsync(100); // poll 1 -> n=1, non-terminal
    await vi.advanceTimersByTimeAsync(100); // poll 2 -> n=2, non-terminal
    await vi.advanceTimersByTimeAsync(100); // poll 3 -> n=3, terminal

    await expect(p).resolves.toEqual({ status: "done", result: { n: 3 } });
    expect(step).toHaveBeenCalledTimes(3);
    expect(onPoll).toHaveBeenCalledTimes(2);
    expect(onPoll).toHaveBeenNthCalledWith(1, { n: 1 });
    expect(onPoll).toHaveBeenNthCalledWith(2, { n: 2 });
  });
});

describe("pollUntil — transient failures + backoff", () => {
  it("treats null as transient, calls onTransientError, grows the delay, then resets on success", async () => {
    vi.useFakeTimers();
    const onTransientError = vi.fn();
    let call = 0;
    const step = vi.fn(async (): Promise<{ done: boolean } | null> => {
      call += 1;
      if (call <= 2) {
        return null; // calls 1, 2: transient
      }
      if (call === 3) {
        return { done: false }; // call 3: non-terminal success -> resets backoff
      }
      return { done: true }; // call 4: terminal
    });

    const p = pollUntil(step, {
      intervalMs: 100,
      backoff: { factor: 2, maxMs: 10_000 },
      until: (r) => r.done,
      onTransientError,
    });

    // Iteration 1: delay = 100 (failures 0).
    await vi.advanceTimersByTimeAsync(100);
    expect(step).toHaveBeenCalledTimes(1);
    expect(onTransientError).toHaveBeenCalledTimes(1);

    // Iteration 2: delay = 100 * 2^1 = 200.
    await vi.advanceTimersByTimeAsync(199);
    expect(step).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(step).toHaveBeenCalledTimes(2);
    expect(onTransientError).toHaveBeenCalledTimes(2);

    // Iteration 3: delay = 100 * 2^2 = 400 -> non-terminal success resets backoff.
    await vi.advanceTimersByTimeAsync(399);
    expect(step).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(step).toHaveBeenCalledTimes(3);

    // Iteration 4: backoff was reset, so delay is back to base 100.
    await vi.advanceTimersByTimeAsync(99);
    expect(step).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(step).toHaveBeenCalledTimes(4);

    await expect(p).resolves.toEqual({ status: "done", result: { done: true } });
    expect(onTransientError).toHaveBeenCalledTimes(2);
  });

  it("caps the backed-off delay at maxMs", async () => {
    vi.useFakeTimers();
    const step = vi.fn(async (): Promise<{ done: boolean } | null> => null);

    const p = pollUntil(step, {
      intervalMs: 100,
      backoff: { factor: 100, maxMs: 250 },
      until: (r) => r.done,
      maxAttempts: 3,
    });

    // Iteration 1: delay 100.
    await vi.advanceTimersByTimeAsync(100);
    expect(step).toHaveBeenCalledTimes(1);

    // Iteration 2: 100 * 100^1 = 10000, capped at 250.
    await vi.advanceTimersByTimeAsync(249);
    expect(step).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(step).toHaveBeenCalledTimes(2);

    // Iteration 3: capped at 250 again.
    await vi.advanceTimersByTimeAsync(250);
    expect(step).toHaveBeenCalledTimes(3);

    // Iteration 4 wake: attempts (4) > maxAttempts (3) -> timeout, no further step.
    await vi.advanceTimersByTimeAsync(250);
    await expect(p).resolves.toEqual({ status: "timeout" });
    expect(step).toHaveBeenCalledTimes(3);
  });

  it("treats a thrown error from step as transient, not fatal", async () => {
    vi.useFakeTimers();
    const onTransientError = vi.fn();
    let call = 0;
    const step = vi.fn(async (): Promise<{ ok: true } | null> => {
      call += 1;
      if (call === 1) {
        throw new Error("boom");
      }
      return { ok: true };
    });

    const p = pollUntil(step, {
      intervalMs: 100,
      until: (r) => r.ok,
      onTransientError,
    });

    await vi.advanceTimersByTimeAsync(100); // poll 1 throws -> transient
    expect(onTransientError).toHaveBeenCalledTimes(1);
    expect(step).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100); // poll 2 -> terminal
    await expect(p).resolves.toEqual({ status: "done", result: { ok: true } });
    expect(step).toHaveBeenCalledTimes(2);
  });
});

describe("pollUntil — budgets", () => {
  it("resolves timeout after maxAttempts non-terminal polls", async () => {
    vi.useFakeTimers();
    const step = vi.fn(async () => ({ ok: false }));

    const p = pollUntil(step, {
      intervalMs: 50,
      maxAttempts: 3,
      until: (r) => r.ok,
    });

    await vi.advanceTimersByTimeAsync(50); // attempt 1
    await vi.advanceTimersByTimeAsync(50); // attempt 2
    await vi.advanceTimersByTimeAsync(50); // attempt 3
    await vi.advanceTimersByTimeAsync(50); // wake 4 -> attempts > max -> timeout

    await expect(p).resolves.toEqual({ status: "timeout" });
    expect(step).toHaveBeenCalledTimes(3);
  });

  it("resolves timeout when the wall-clock deadline is exceeded", async () => {
    vi.useFakeTimers();
    const step = vi.fn(async () => ({ ok: false }));

    const p = pollUntil(step, {
      intervalMs: 100,
      timeoutMs: 250,
      until: (r) => r.ok,
    });

    await vi.advanceTimersByTimeAsync(100); // t=100, elapsed 100 < 250, poll 1
    await vi.advanceTimersByTimeAsync(100); // t=200, elapsed 200 < 250, poll 2
    await vi.advanceTimersByTimeAsync(100); // t=300, elapsed 300 >= 250 -> timeout

    await expect(p).resolves.toEqual({ status: "timeout" });
    expect(step).toHaveBeenCalledTimes(2);
  });
});

describe("pollUntil — abort", () => {
  it("returns aborted immediately when the signal is already aborted, without polling", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const step = vi.fn(async () => ({ ok: true }));

    const outcome = await pollUntil(step, {
      intervalMs: 100,
      until: () => true,
      signal: ctrl.signal,
    });

    expect(outcome).toEqual({ status: "aborted" });
    expect(step).not.toHaveBeenCalled();
  });

  it("resolves aborted when the signal fires during the wait", async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const step = vi.fn(async () => ({ ok: true }));

    const p = pollUntil(step, {
      intervalMs: 1000,
      until: () => true,
      signal: ctrl.signal,
    });

    await vi.advanceTimersByTimeAsync(500); // mid-wait, timer not yet fired
    expect(step).not.toHaveBeenCalled();

    ctrl.abort(); // wakes the abort-aware sleep early
    await expect(p).resolves.toEqual({ status: "aborted" });
    expect(step).not.toHaveBeenCalled();
  });
});

describe("pollUntil — callback safety", () => {
  it("catches an error thrown by onPoll and keeps polling", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let n = 0;
    const onPoll = vi.fn(() => {
      throw new Error("kaboom");
    });
    const step = vi.fn(async () => ({ n: ++n }));

    const p = pollUntil(step, {
      intervalMs: 100,
      until: (r) => r.n >= 2,
      onPoll,
    });

    await vi.advanceTimersByTimeAsync(100); // poll 1 -> n=1, onPoll throws, caught
    expect(onPoll).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100); // poll 2 -> terminal
    await expect(p).resolves.toEqual({ status: "done", result: { n: 2 } });
  });

  it("catches an error thrown by onTransientError and keeps polling", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let call = 0;
    const onTransientError = vi.fn(() => {
      throw new Error("kaboom");
    });
    const step = vi.fn(async (): Promise<{ ok: true } | null> => {
      call += 1;
      return call === 1 ? null : { ok: true };
    });

    const p = pollUntil(step, {
      intervalMs: 100,
      until: (r) => r.ok,
      onTransientError,
    });

    await vi.advanceTimersByTimeAsync(100); // poll 1 -> null, onTransientError throws, caught
    expect(onTransientError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100); // poll 2 -> terminal
    await expect(p).resolves.toEqual({ status: "done", result: { ok: true } });
  });

  it("abort during step() wins over transient (no onTransientError)", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const onTransientError = vi.fn();
    let calls = 0;
    const p = pollUntil<{ done: boolean }>(
      async () => {
        calls += 1;
        ac.abort(); // signal aborts while this poll is in flight
        return null; // and the poll also "fails" transiently
      },
      { intervalMs: 100, until: (r) => r.done, signal: ac.signal, onTransientError },
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toEqual({ status: "aborted" });
    expect(calls).toBe(1);
    expect(onTransientError).not.toHaveBeenCalled();
  });
});
