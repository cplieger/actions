// Two rules pollUntil states in its own doc comments but the suite does not
// pin: `backoff` applies only AFTER a consecutive transient failure (so its
// `maxMs` cap can never shorten the first wait), and each wait's abortable
// sleep tears its own listener off the caller's signal whichever side of the
// race wins — a long poll on one signal must not accumulate listeners.
import { describe, it, expect, vi, afterEach } from "vitest";

import { pollUntil } from "./poll-until.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function abortOptions(
  spy: ReturnType<typeof vi.spyOn<AbortSignal, "addEventListener">>,
): { signal?: AbortSignal } | undefined {
  const call = spy.mock.calls.find(([type]) => type === "abort");
  return call?.[2] as { signal?: AbortSignal } | undefined;
}

describe("pollUntil — backoff applies only after a transient failure", () => {
  it("waits the full base interval before the first poll even when the backoff cap is shorter", async () => {
    vi.useFakeTimers();
    const step = vi.fn(() => Promise.resolve("ready"));

    const outcome = pollUntil<string>(step, {
      intervalMs: 1000,
      until: (r) => r === "ready",
      // maxMs deliberately BELOW intervalMs: it bounds the GROWN delay, so with
      // zero failures the first wait is the plain interval.
      backoff: { factor: 2, maxMs: 250 },
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(step).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(750);
    await expect(outcome).resolves.toEqual({ status: "done", result: "ready" });
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("applies the cap to the wait that follows a transient failure", async () => {
    vi.useFakeTimers();
    const step = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue("ready");

    const outcome = pollUntil<string>(step, {
      intervalMs: 1000,
      until: (r) => r === "ready",
      backoff: { factor: 2, maxMs: 250 },
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(step).toHaveBeenCalledTimes(1);

    // failures === 1 => min(1000 * 2, 250) === 250.
    await vi.advanceTimersByTimeAsync(250);
    await expect(outcome).resolves.toEqual({ status: "done", result: "ready" });
    expect(step).toHaveBeenCalledTimes(2);
  });
});

describe("pollUntil — the abortable wait cleans up after itself", () => {
  it("detaches the wait's abort listener from the caller signal once the timer wins", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const addSpy = vi.spyOn(ac.signal, "addEventListener");
    const step = vi.fn(() => Promise.resolve("ready"));

    const outcome = pollUntil<string>(step, {
      intervalMs: 500,
      until: () => true,
      signal: ac.signal,
    });

    const opts = abortOptions(addSpy);
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    expect(opts?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    await expect(outcome).resolves.toEqual({ status: "done", result: "ready" });

    // The wait's own controller is what removes the listener it added to the
    // caller's signal; leaving it un-aborted leaks one listener per iteration.
    expect(opts?.signal?.aborted).toBe(true);
  });

  it("detaches the wait's abort listener when the caller signal wins the race", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const addSpy = vi.spyOn(ac.signal, "addEventListener");
    const step = vi.fn(() => Promise.resolve("ready"));

    const outcome = pollUntil<string>(step, {
      intervalMs: 5000,
      until: () => true,
      signal: ac.signal,
    });

    const opts = abortOptions(addSpy);
    expect(opts?.signal?.aborted).toBe(false);

    ac.abort();

    await expect(outcome).resolves.toEqual({ status: "aborted" });
    expect(step).not.toHaveBeenCalled();
    expect(opts?.signal?.aborted).toBe(true);
  });
});
