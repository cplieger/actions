// Retry policy: the exponential backoff schedule, the attempt count recorded
// on every terminal registry entry, and the two fail-closed edges (a throwing
// `retryable` predicate, and a signal already aborted at the top of the loop).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));
import { defineAction, _resetForTest as resetDefine } from "./define.js";
import { getActionLog, _resetForTest as resetRegistry } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";
import { ActionError } from "./error.js";
import type { Action, ActionInstance } from "./types.js";

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

/** The terminal (non-pending) registry entry for an action name. */
function terminalEntry(name: string): ActionInstance | undefined {
  return getActionLog().find((e) => e.name === name && e.status !== "pending");
}

describe("retry backoff schedule", () => {
  it("multiplies the delay by the factor on each attempt (100ms then 200ms)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const action = defineAction<void, string>({
      name: "backoff.growth",
      retry: { count: 2, delay: 100, factor: 2 },
      retryable: () => true,
      error: false,
      run: () => {
        calls += 1;
        return Promise.reject(new ActionError("transient", { code: "network" }));
      },
    });

    const p = action.dispatch();
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);

    // The second backoff is 100 * 2^1 = 200ms. A shrinking schedule (100 / 2^1
    // = 50ms) would have fired the third attempt long before this point.
    await vi.advanceTimersByTimeAsync(199);
    expect(calls).toBe(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(3);

    await p;
  });
});

describe("attempt count recorded on terminal entries", () => {
  it("records the attempts on a dispatch that failed every retry", async () => {
    const action = defineAction<void, string>({
      name: "attempts.exhausted",
      retry: { count: 1, delay: 0 },
      retryable: () => true,
      error: false,
      run: () => Promise.reject(new ActionError("transient", { code: "network" })),
    });

    await action.dispatch();

    expect(terminalEntry("attempts.exhausted")?.status).toBe("error");
    expect(terminalEntry("attempts.exhausted")?.attempts).toBe(2);
  });

  it("records the attempts reached when cancelled mid-attempt", async () => {
    const action = defineAction<void, string>({
      name: "attempts.cancel_in_run",
      error: false,
      run: (_args, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });

    const p = action.dispatch();
    action.cancel();
    await p;

    expect(terminalEntry("attempts.cancel_in_run")?.status).toBe("cancelled");
    expect(terminalEntry("attempts.cancel_in_run")?.attempts).toBe(1);
  });

  it("records the attempts reached when cancelled during the retry backoff", async () => {
    vi.useFakeTimers();
    const action = defineAction<void, string>({
      name: "attempts.cancel_in_backoff",
      retry: { count: 2, delay: 1000 },
      retryable: () => true,
      error: false,
      run: () => Promise.reject(new ActionError("transient", { code: "network" })),
    });

    const p = action.dispatch();
    await vi.advanceTimersByTimeAsync(0);
    action.cancel();
    await p;

    expect(terminalEntry("attempts.cancel_in_backoff")?.status).toBe("cancelled");
    expect(terminalEntry("attempts.cancel_in_backoff")?.attempts).toBe(1);
  });

  it("records zero attempts when the dispatch is cancelled before the first attempt", async () => {
    let calls = 0;
    const holder: { action?: Action<void, string> } = {};
    holder.action = defineAction<void, string, null>({
      name: "attempts.cancel_pre_run",
      error: false,
      optimistic: () => {
        // A cancel raised from optimistic() aborts the signal before
        // runWithRetry reaches its first attempt.
        holder.action?.cancel();
        return null;
      },
      run: () => {
        calls += 1;
        return Promise.resolve("unreachable");
      },
    });

    await holder.action.dispatch();

    expect(calls).toBe(0);
    expect(terminalEntry("attempts.cancel_pre_run")?.status).toBe("cancelled");
    expect(terminalEntry("attempts.cancel_pre_run")?.attempts).toBe(0);
  });

  it("records the attempts reached when cancelled during the offline pause", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const action = defineAction<void, string>({
      name: "attempts.cancel_offline",
      retry: { count: 2, delay: 0 },
      retryable: () => true,
      error: false,
      run: () => Promise.reject(new ActionError("offline", { code: "network" })),
    });

    const p = action.dispatch();
    await Promise.resolve();
    await Promise.resolve();
    action.cancel();
    await p;

    expect(terminalEntry("attempts.cancel_offline")?.status).toBe("cancelled");
    expect(terminalEntry("attempts.cancel_offline")?.attempts).toBe(1);
  });
});

describe("retryable predicate that throws", () => {
  it("treats a throwing retryable as non-retryable (fails closed)", async () => {
    let calls = 0;
    const action = defineAction<void, string>({
      name: "retryable.throws",
      retry: { count: 2, delay: 0 },
      retryable: () => {
        throw new Error("predicate blew up");
      },
      error: false,
      run: () => {
        calls += 1;
        return Promise.reject(new ActionError("transient", { code: "network" }));
      },
    });

    await action.dispatch();

    expect(calls).toBe(1);
    expect(terminalEntry("retryable.throws")?.attempts).toBe(1);
  });
});
