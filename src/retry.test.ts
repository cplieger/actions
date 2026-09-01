// Node env (no window) is deliberate: exercises waitForOnline's non-window
// branch, which defineAction's own retry loop leaves unpinned.
import { describe, it, expect, vi, afterEach } from "vitest";
import { sleep, waitForOnline, attachAttempts, readAttempts } from "./retry.js";

/** Settlement probe: records how a promise settled without awaiting it, so a
 *  test can assert "still pending" instead of hanging on it. */
function probe(p: Promise<void>): () => string {
  let state = "pending";
  void p.then(
    () => {
      state = "resolved";
    },
    (e: unknown) => {
      state = `rejected:${(e as Error).name}`;
    },
  );
  return () => state;
}

/** Drain the microtask queue so an already-settled promise's handlers have run. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sleep", () => {
  it("rejects with AbortError when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleep(50, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("resolves immediately for ms <= 0 without scheduling a timer", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const p = sleep(0, ac.signal);
    expect(vi.getTimerCount()).toBe(0);
    await expect(p).resolves.toBeUndefined();
  });

  it("clears the pending timer when the signal aborts mid-sleep", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const p = sleep(1000, ac.signal);
    expect(vi.getTimerCount()).toBe(1);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("waitForOnline", () => {
  it("resolves immediately when the browser reports online", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const ac = new AbortController();
    const state = probe(waitForOnline(ac.signal));
    await flush();
    expect(state()).toBe("resolved");
  });

  it("rejects immediately when offline and the signal is already aborted", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const ac = new AbortController();
    ac.abort();
    const state = probe(waitForOnline(ac.signal));
    await flush();
    expect(state()).toBe("rejected:AbortError");
  });

  it("stays pending without a window until the signal aborts", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const ac = new AbortController();
    const state = probe(waitForOnline(ac.signal));
    await flush();
    expect(state()).toBe("pending");
    ac.abort();
    await flush();
    expect(state()).toBe("rejected:AbortError");
  });
});

describe("attachAttempts", () => {
  it("overwrites the attempt count when attached twice", () => {
    const e = new Error("boom");
    attachAttempts(e, 1);
    attachAttempts(e, 3);
    expect(readAttempts(e)).toBe(3);
  });

  it("leaves a thrown function untouched", () => {
    const thrown = (): void => {
      /* a function is a legal throwable and is not an object */
    };
    attachAttempts(thrown, 2);
    expect(Object.getOwnPropertyDescriptor(thrown, "_attempts")).toBeUndefined();
    expect(readAttempts(thrown)).toBeUndefined();
  });
});
