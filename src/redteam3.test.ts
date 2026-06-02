// @vitest-environment happy-dom
// RED-TEAM round 3 (final sweep): full lifecycle race matrix, AbortSignal
// listener leaks, prepareHeaders/fetchFn error paths, registry bounds under load.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));

import { apiAction, configureApi, _resetApiConfigForTest } from "./api.js";
import { defineAction, _resetForTest as resetDefine, _internalsForTest } from "./define.js";
import { _resetForTest as resetRegistry, recentLog, isPending, pendingCount } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";

const mockFetch = vi.fn();

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
  _resetApiConfigForTest();
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Full lifecycle race matrix: dispatch/cancel/abort/timeout/retry/dedupe/scope
// ---------------------------------------------------------------------------
describe("lifecycle race matrix", () => {
  it("cancel() during retry backoff with dedupe + scope — no leak, correct status", async () => {
    let attempt = 0;
    const action = defineAction({
      name: "race.matrix.1",
      scope: "race-scope",
      dedupe: true,
      timeout: 5000,
      retry: { count: 5, delay: 100 },
      retryable: () => true,
      run: async (_a, signal) => {
        attempt++;
        if (attempt <= 2) throw new Error("transient");
        // After 2 failures, wait for signal
        await new Promise<never>((_r, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      },
    });
    const handle = action.dispatch("x");
    // Let first two attempts fail and enter backoff
    await new Promise((r) => setTimeout(r, 50));
    // Cancel mid-flight
    action.cancel();
    const result = await handle;
    expect(result).toBeNull();
    const entry = recentLog().find((e) => e.name === "race.matrix.1");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("cancelled");
    // Verify no leaks in internal maps
    const internals = _internalsForTest();
    expect(internals.activeDedupes).toBe(0);
  });

  it("abort() on deduped follower while leader is in-flight — follower settles, leader continues", async () => {
    let leaderResolve!: (v: string) => void;
    const action = defineAction({
      name: "race.dedupe.abort",
      dedupe: true,
      run: () => new Promise<string>((r) => { leaderResolve = r; }),
    });
    const h1 = action.dispatch("a");
    const onError2 = vi.fn();
    const onSettled2 = vi.fn();
    const h2 = action.dispatch("a", { onError: onError2, onSettled: onSettled2 });
    // Abort the follower handle — but since dedupe shares the promise, abort is a no-op
    h2.abort();
    // Resolve the leader
    leaderResolve("done");
    const r1 = await h1;
    const r2 = await h2;
    expect(r1).toBe("done");
    // Follower gets the result too (abort on follower is NOOP for dedupe)
    expect(r2).toBe("done");
    expect(onSettled2).toHaveBeenCalledTimes(1);
  });

  it("scope-queued dispatch cancelled via action.cancel() before run starts — records cancelled, no run", async () => {
    const runSpy = vi.fn().mockResolvedValue("ok");
    let blockerResolve!: (v: string) => void;
    const action = defineAction({
      name: "race.scope.cancel",
      scope: "cancel-scope",
      run: (args, _signal) => {
        if (args === "blocker") {
          return new Promise<string>((r) => { blockerResolve = r; });
        }
        runSpy();
        return Promise.resolve("target-done");
      },
    });
    const h1 = action.dispatch("blocker" as string);
    await Promise.resolve(); // let blocker start
    const h2 = action.dispatch("target" as string);
    // Cancel all before target starts
    action.cancel();
    blockerResolve("blocker-done");
    await h1;
    const r2 = await h2;
    expect(r2).toBeNull();
    expect(runSpy).not.toHaveBeenCalled();
    const entries = recentLog().filter((e) => e.name === "race.scope.cancel");
    const targetEntry = entries.find((e) => e.args === "target");
    expect(targetEntry?.status).toBe("cancelled");
  });

  it("rapid dispatch+cancel+dispatch cycle does not corrupt state", async () => {
    let callCount = 0;
    const action = defineAction({
      name: "race.rapid",
      run: async () => { callCount++; return callCount; },
    });
    const h1 = action.dispatch("a");
    h1.abort();
    const h2 = action.dispatch("b");
    const h3 = action.dispatch("c");
    h3.abort();
    const [r1, r2, r3] = await Promise.all([h1, h2, h3]);
    expect(r1).toBeNull(); // aborted
    expect(r2).toBeGreaterThanOrEqual(1); // should succeed
    expect(r3).toBeNull(); // aborted
  });
});

// ---------------------------------------------------------------------------
// 2. AbortSignal listener leaks
// ---------------------------------------------------------------------------
describe("AbortSignal listener leaks", () => {
  it("sleep() cleans up abort listener on normal resolve", async () => {
    const { sleep } = await import("./retry.js");
    const ac = new AbortController();
    // Spy on removeEventListener
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    await sleep(1, ac.signal);
    // The abort listener should have been removed after timer fires
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("sleep() cleans up timer on abort", async () => {
    const { sleep } = await import("./retry.js");
    const ac = new AbortController();
    const p = sleep(100000, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow();
    // No lingering timer — if it leaked, the test process would hang
  });

  it("waitForOnline() cleans up listeners on abort", async () => {
    const { waitForOnline } = await import("./retry.js");
    // Simulate offline
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    const p = waitForOnline(ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(removeSpy).toHaveBeenCalled();
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  });

  it("many dispatches with timeout do not accumulate listeners", async () => {
    vi.useFakeTimers();
    const action = defineAction({
      name: "leak.timeout",
      timeout: 1000,
      run: async () => "ok",
    });
    const handles = [];
    for (let i = 0; i < 50; i++) {
      handles.push(action.dispatch(`arg-${i}`));
    }
    await vi.advanceTimersByTimeAsync(10);
    const results = await Promise.all(handles);
    // All should succeed (run is instant)
    expect(results.every((r) => r === "ok")).toBe(true);
    // Verify no internal map leaks
    const internals = _internalsForTest();
    expect(internals.scopeChains).toBe(0);
    expect(internals.activeDedupes).toBe(0);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 3. prepareHeaders / fetchFn error paths
// ---------------------------------------------------------------------------
describe("prepareHeaders / fetchFn error paths", () => {
  it("prepareHeaders returning a rejected promise with non-Error value", async () => {
    configureApi({
      prepareHeaders: () => Promise.reject("string-rejection"),
    });
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const action = apiAction<void>({
      name: "prep.string.reject",
      request: () => ({ method: "GET", path: "/x" }),
    });
    const result = await action.dispatch(undefined);
    expect(result).toBeNull();
    const entry = recentLog().find((e) => e.name === "prep.string.reject");
    expect(entry?.status).toBe("error");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetchFn returning a rejected promise with DOMException TimeoutError", async () => {
    configureApi({
      fetchFn: () => Promise.reject(new DOMException("timed out", "TimeoutError")),
    });
    const action = apiAction<void>({
      name: "fetch.timeout.dom",
      request: () => ({ method: "GET", path: "/x" }),
    });
    const result = await action.dispatch(undefined);
    expect(result).toBeNull();
    const entry = recentLog().find((e) => e.name === "fetch.timeout.dom");
    expect(entry?.status).toBe("error");
    expect(entry?.error?.code).toBe("timeout");
  });

  it("fetchFn throwing after signal is aborted classifies as cancelled", async () => {
    configureApi({
      fetchFn: async (_url, init) => {
        const signal = (init as RequestInit).signal!;
        // Wait until signal aborts
        await new Promise<void>((r) => {
          signal.addEventListener("abort", () => r());
        });
        throw new DOMException("aborted", "AbortError");
      },
    });
    const action = apiAction<void>({
      name: "fetch.abort.classify",
      request: () => ({ method: "GET", path: "/x" }),
    });
    const handle = action.dispatch(undefined);
    // Abort immediately
    handle.abort();
    const result = await handle;
    expect(result).toBeNull();
    const entry = recentLog().find((e) => e.name === "fetch.abort.classify");
    expect(entry?.status).toBe("cancelled");
  });

  it("prepareHeaders mutating headers does not affect subsequent requests", async () => {
    let callCount = 0;
    configureApi({
      prepareHeaders: (headers) => {
        callCount++;
        headers.set("X-Seq", String(callCount));
      },
    });
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const action = apiAction<number>({
      name: "prep.no.bleed",
      request: (n) => ({ method: "GET", path: `/x/${n}` }),
    });
    await action.dispatch(1);
    await action.dispatch(2);
    const h1 = (mockFetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    const h2 = (mockFetch.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(h1["x-seq"]).toBe("1");
    expect(h2["x-seq"]).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// 4. Registry bounds under load
// ---------------------------------------------------------------------------
describe("registry bounds under load", () => {
  it("registry does not grow unbounded with 500+ dispatches", async () => {
    const action = defineAction({
      name: "reg.load",
      run: async (n: number) => n * 2,
    });
    const promises = [];
    for (let i = 0; i < 500; i++) {
      promises.push(action.dispatch(i));
    }
    await Promise.all(promises);
    const log = recentLog();
    // Registry should be bounded (MAX_LOG_SIZE = 200)
    expect(log.length).toBeLessThanOrEqual(250);
    // All should be terminal (no pending leaks)
    expect(log.every((e) => e.status !== "pending")).toBe(true);
    expect(pendingCount()).toBe(0);
  });

  it("pendingCount stays accurate under rapid dispatch/settle", async () => {
    const resolvers: ((v: string) => void)[] = [];
    const action = defineAction({
      name: "reg.pending",
      run: () => new Promise<string>((r) => { resolvers.push(r); }),
    });
    // Dispatch 10 concurrent
    for (let i = 0; i < 10; i++) {
      action.dispatch(`arg-${i}`);
    }
    await Promise.resolve();
    expect(pendingCount(["reg.pending"])).toBe(10);
    expect(isPending("reg.pending")).toBe(true);
    // Resolve half
    for (let i = 0; i < 5; i++) {
      resolvers[i]!("done");
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(pendingCount(["reg.pending"])).toBe(5);
    // Resolve rest
    for (let i = 5; i < 10; i++) {
      resolvers[i]!("done");
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(pendingCount(["reg.pending"])).toBe(0);
    expect(isPending("reg.pending")).toBe(false);
  });

  it("registry eviction preserves pending entries", async () => {
    let pendingResolve!: (v: string) => void;
    const slowAction = defineAction({
      name: "reg.evict.slow",
      run: () => new Promise<string>((r) => { pendingResolve = r; }),
    });
    const fastAction = defineAction({
      name: "reg.evict.fast",
      run: async () => "fast",
    });
    // Start a slow action
    const slowHandle = slowAction.dispatch("slow");
    await Promise.resolve();
    // Flood with fast actions to trigger eviction
    for (let i = 0; i < 300; i++) {
      await fastAction.dispatch(String(i));
    }
    // Slow action should still be tracked as pending
    expect(isPending("reg.evict.slow")).toBe(true);
    // Resolve it
    pendingResolve("finally");
    const result = await slowHandle;
    expect(result).toBe("finally");
    expect(isPending("reg.evict.slow")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Verify round 1-2 fixes are sound
// ---------------------------------------------------------------------------
describe("verify round 1-2 fixes", () => {
  it("baseUrl join: no double slash (regression)", async () => {
    configureApi({ baseUrl: "https://api.example.com/" });
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const action = apiAction<void>({
      name: "verify.baseurl",
      request: () => ({ method: "GET", path: "/users/1" }),
    });
    await action.dispatch(undefined);
    expect(mockFetch.mock.calls[0]![0]).toBe("https://api.example.com/users/1");
  });

  it("timeout error code is 'timeout' not 'cancelled' (regression)", async () => {
    const action = defineAction({
      name: "verify.timeout.code",
      timeout: 10,
      run: (_a, signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });
    const result = await action.dispatch("x");
    expect(result).toBeNull();
    const entry = recentLog().find((e) => e.name === "verify.timeout.code" && e.status !== "pending");
    expect(entry).toBeDefined();
    // Must be error with timeout code, not cancelled
    expect(entry!.status).toBe("error");
    expect(entry!.error?.code).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// 6. Scope chain cleanup after errors
// ---------------------------------------------------------------------------
describe("scope chain cleanup", () => {
  it("scope chain is released after run() throws — next dispatch proceeds", async () => {
    let callCount = 0;
    const action = defineAction({
      name: "scope.error.release",
      scope: "err-scope",
      run: async () => {
        callCount++;
        if (callCount === 1) throw new Error("first fails");
        return "second-ok";
      },
    });
    const r1 = await action.dispatch("a");
    expect(r1).toBeNull(); // first fails
    const r2 = await action.dispatch("b");
    expect(r2).toBe("second-ok"); // second should not be stuck
    expect(_internalsForTest().scopeChains).toBe(0);
  });

  it("scope chain is released after cancel — next dispatch proceeds", async () => {
    let resolve1!: (v: string) => void;
    const action = defineAction({
      name: "scope.cancel.release",
      scope: "cancel-scope-2",
      run: (args) => {
        if (args === "first") {
          return new Promise<string>((r) => { resolve1 = r; });
        }
        return Promise.resolve("second-ok");
      },
    });
    const h1 = action.dispatch("first" as string);
    await Promise.resolve();
    h1.abort();
    resolve1("ignored");
    await h1;
    const r2 = await action.dispatch("second" as string);
    expect(r2).toBe("second-ok");
    expect(_internalsForTest().scopeChains).toBe(0);
  });
});
