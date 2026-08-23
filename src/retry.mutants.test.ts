// @vitest-environment happy-dom
// retry.ts's listener bookkeeping and the two guards that are not just
// belt-and-braces. Both `sleep` and `waitForOnline` run once per retry attempt
// against a signal that outlives them, so each has to detach whatever it
// attached on BOTH sides of its race — the leak is per-attempt, not per-action.
import { describe, it, expect, vi, afterEach } from "vitest";

import { attachAttempts, readAttempts, sleep, waitForOnline } from "./retry.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

function goOffline(): void {
  Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
}

describe("sleep — abort-listener bookkeeping", () => {
  it("registers a once-only abort listener and removes it when the timer wins", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const add = vi.spyOn(ac.signal, "addEventListener");
    const remove = vi.spyOn(ac.signal, "removeEventListener");

    const slept = sleep(50, ac.signal);

    const abortCall = add.mock.calls.find(([type]) => type === "abort");
    expect(abortCall).toBeDefined();
    expect(abortCall?.[2]).toEqual({ once: true });

    await vi.advanceTimersByTimeAsync(50);
    await expect(slept).resolves.toBeUndefined();

    // The signal belongs to the whole dispatch, not to this one backoff wait:
    // a listener left behind here accumulates once per retry attempt.
    expect(remove).toHaveBeenCalledWith("abort", abortCall?.[1]);
  });

  it("rejects with an AbortError when the signal wins", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const slept = sleep(5000, ac.signal);
    ac.abort();
    await expect(slept).rejects.toThrow(/aborted/);
  });
});

describe("waitForOnline — the no-navigator guard", () => {
  it("resolves without reading navigator when there is no navigator at all", async () => {
    // The SSR / worker shape the guard exists for: `navigator` undefined, so
    // reading `.onLine` would throw rather than answer "assume online".
    vi.stubGlobal("navigator", undefined);
    const ac = new AbortController();
    await expect(waitForOnline(ac.signal)).resolves.toBeUndefined();
  });

  it("resolves immediately when navigator reports online", async () => {
    const ac = new AbortController();
    await expect(waitForOnline(ac.signal)).resolves.toBeUndefined();
  });
});

describe("waitForOnline — listener bookkeeping while offline", () => {
  it("removes both listeners when the online event wins", async () => {
    goOffline();
    const ac = new AbortController();
    const signalAdd = vi.spyOn(ac.signal, "addEventListener");
    const signalRemove = vi.spyOn(ac.signal, "removeEventListener");
    const windowAdd = vi.spyOn(window, "addEventListener");
    const windowRemove = vi.spyOn(window, "removeEventListener");

    const waiting = waitForOnline(ac.signal);

    const onlineCall = windowAdd.mock.calls.find(([type]) => type === "online");
    const abortCall = signalAdd.mock.calls.find(([type]) => type === "abort");
    expect(onlineCall).toBeDefined();
    expect(abortCall).toBeDefined();
    expect(onlineCall?.[2]).toEqual({ once: true });
    expect(abortCall?.[2]).toEqual({ once: true });

    window.dispatchEvent(new Event("online"));
    await expect(waiting).resolves.toBeUndefined();

    expect(windowRemove).toHaveBeenCalledWith("online", onlineCall?.[1]);
    expect(signalRemove).toHaveBeenCalledWith("abort", abortCall?.[1]);
  });

  it("removes the online listener when the signal aborts first", async () => {
    goOffline();
    const ac = new AbortController();
    const signalRemove = vi.spyOn(ac.signal, "removeEventListener");
    const windowAdd = vi.spyOn(window, "addEventListener");
    const windowRemove = vi.spyOn(window, "removeEventListener");

    const waiting = waitForOnline(ac.signal);
    const onlineCall = windowAdd.mock.calls.find(([type]) => type === "online");
    expect(onlineCall).toBeDefined();

    ac.abort();
    await expect(waiting).rejects.toThrow(/aborted/);

    // The abort arm has to clean up the window listener too: the pending
    // `online` subscription would otherwise outlive the cancelled dispatch.
    expect(windowRemove).toHaveBeenCalledWith("online", onlineCall?.[1]);
    expect(signalRemove).toHaveBeenCalled();
  });

  it("rejects immediately for a signal that is already aborted while offline", async () => {
    goOffline();
    const ac = new AbortController();
    ac.abort();
    await expect(waitForOnline(ac.signal)).rejects.toThrow(/aborted/);
  });
});

describe("readAttempts / attachAttempts agree on what can carry an attempt count", () => {
  it("ignores an _attempts property on a thrown function, which attachAttempts never stamps", () => {
    const thrown = (): void => undefined;
    Object.defineProperty(thrown, "_attempts", { value: 3, configurable: true });

    // attachAttempts only stamps `typeof e === "object"` throwables, so a
    // function's own `_attempts` is not retry metadata and must not be read as
    // one — otherwise an unrelated property becomes a fake attempt count.
    attachAttempts(thrown, 7);
    expect(readAttempts(thrown)).toBeUndefined();
  });

  it("round-trips an attempt count through an object throwable", () => {
    const thrown = new Error("boom");
    attachAttempts(thrown, 4);
    expect(readAttempts(thrown)).toBe(4);
    expect(Object.keys(thrown)).not.toContain("_attempts");
  });

  it("returns undefined for a non-numeric _attempts", () => {
    const thrown = { _attempts: "3" };
    expect(readAttempts(thrown)).toBeUndefined();
  });
});
