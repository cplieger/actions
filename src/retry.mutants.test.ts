// sleep/waitForOnline run once per retry attempt against a signal that
// outlives them, so each must detach its listener on BOTH sides of its race.
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

/** Reports how `p` settles within `ms`, without asserting. At `ms` of 0 the
 *  deadline is a macrotask, which an already-resolved promise always beats. */
function settleWithin(p: Promise<void>, ms: number): Promise<"resolved" | "rejected" | "pending"> {
  const deadline = new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms));
  return Promise.race([
    p.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    deadline,
  ]);
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

    // A listener left behind here accumulates once per retry attempt.
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

describe("waitForOnline — only a positive offline report waits", () => {
  it("resolves when there is no navigator at all", async () => {
    // Only a stub reaches this arm: Node has had `navigator` since v21 and a
    // Web Worker's has a real `onLine`.
    vi.stubGlobal("navigator", undefined);
    const ac = new AbortController();
    expect(await settleWithin(waitForOnline(ac.signal), 0)).toBe("resolved");
  });

  it("resolves when navigator carries no onLine property, which is Node's real shape", async () => {
    // Node's real shape: `onLine` undefined here read as offline previously
    // stalled every retrying action on its first retry (no window to fire `online`).
    vi.stubGlobal("navigator", {});
    const ac = new AbortController();
    expect(await settleWithin(waitForOnline(ac.signal), 0)).toBe("resolved");
  });

  it("resolves immediately when the real navigator reports online", async () => {
    const ac = new AbortController();
    expect(await settleWithin(waitForOnline(ac.signal), 0)).toBe("resolved");
  });

  it("keeps waiting while navigator positively reports offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const ac = new AbortController();
    const waiting = waitForOnline(ac.signal);

    expect(await settleWithin(waiting, 50)).toBe("pending");

    ac.abort();
    await expect(waiting).rejects.toThrow(/aborted/);
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

    // Otherwise the pending `online` subscription outlives the cancelled dispatch.
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

    // attachAttempts only stamps object throwables; a function's own
    // `_attempts` must not be read as one, or it becomes a fake attempt count.
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
