// @vitest-environment happy-dom
// RED-TEAM adversarial tests: probing edge cases not covered by existing tests.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));

import { apiAction, configureApi, _resetApiConfigForTest } from "./api.js";
import { defineAction, _resetForTest as resetDefine } from "./define.js";
import { _resetForTest as resetRegistry, recentLog } from "./registry.js";
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
// 1. configureApi baseUrl joining — double slash
// ---------------------------------------------------------------------------
describe("configureApi baseUrl joining edge cases", () => {
  it("does NOT produce double slash when baseUrl ends with / and path starts with /", async () => {
    configureApi({ baseUrl: "https://api.example.com/" });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({
      name: "base.dblslash",
      request: (id) => ({ method: "GET", path: `/items/${id}` }),
    });
    await action.dispatch("42");
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toBe("https://api.example.com/items/42");
    expect(url).not.toContain("//items");
  });

  it("handles baseUrl without trailing slash and path with leading slash", async () => {
    configureApi({ baseUrl: "https://api.example.com" });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({
      name: "base.noslash",
      request: () => ({ method: "GET", path: "/items" }),
    });
    await action.dispatch("x");
    expect(mockFetch.mock.calls[0]![0]).toBe("https://api.example.com/items");
  });

  it("handles baseUrl with trailing slash and path without leading slash", async () => {
    configureApi({ baseUrl: "https://api.example.com/" });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({
      name: "base.trailslash",
      request: () => ({ method: "GET", path: "items" }),
    });
    await action.dispatch("x");
    expect(mockFetch.mock.calls[0]![0]).toBe("https://api.example.com/items");
  });
});

// ---------------------------------------------------------------------------
// 2. prepareHeaders async rejection
// ---------------------------------------------------------------------------
describe("prepareHeaders async rejection", () => {
  it("surfaces as an action error (not unhandled rejection)", async () => {
    configureApi({
      prepareHeaders: async () => {
        throw new Error("token refresh failed");
      },
    });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({
      name: "prep.reject",
      request: () => ({ method: "GET", path: "/x" }),
    });
    const result = await action.dispatch("x");
    expect(result).toBeNull();
    expect(recentLog()[0]?.status).toBe("error");
    expect(recentLog()[0]?.error?.message).toContain("token refresh failed");
    // fetch should NOT have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("prepareHeaders sync throw also surfaces as action error", async () => {
    configureApi({
      prepareHeaders: () => {
        throw new Error("sync boom");
      },
    });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({
      name: "prep.sync.throw",
      request: () => ({ method: "GET", path: "/x" }),
    });
    const result = await action.dispatch("x");
    expect(result).toBeNull();
    expect(recentLog()[0]?.status).toBe("error");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. fetchFn throwing synchronously
// ---------------------------------------------------------------------------
describe("fetchFn throwing synchronously", () => {
  it("surfaces as a classified action error", async () => {
    configureApi({
      fetchFn: () => {
        throw new TypeError("sync network failure");
      },
    });
    const action = apiAction<string>({
      name: "fetch.sync.throw",
      request: () => ({ method: "GET", path: "/x" }),
    });
    const result = await action.dispatch("x");
    expect(result).toBeNull();
    expect(recentLog()[0]?.status).toBe("error");
    expect(recentLog()[0]?.error?.code).toBe("network");
  });
});

// ---------------------------------------------------------------------------
// 4. abort handle — abort after settle (double-abort)
// ---------------------------------------------------------------------------
describe("abort handle edge cases", () => {
  it("abort() after settlement is a no-op (no double-fire of callbacks)", async () => {
    const onSettled = vi.fn();
    const action = defineAction({
      name: "abort.after.settle",
      run: async () => "done",
    });
    const handle = action.dispatch("x", { onSettled });
    const result = await handle;
    expect(result).toBe("done");
    expect(onSettled).toHaveBeenCalledTimes(1);
    // abort after settle
    handle.abort();
    // Give microtask queue a chance to flush
    await Promise.resolve();
    expect(onSettled).toHaveBeenCalledTimes(1); // still 1
  });

  it("double-abort does not throw or double-fire", async () => {
    const onSettled = vi.fn();
    const action = defineAction({
      name: "abort.double",
      run: (_a, signal) =>
        new Promise<string>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
          setTimeout(() => resolve("late"), 1000);
        }),
    });
    const handle = action.dispatch("x", { onSettled });
    handle.abort();
    handle.abort(); // second abort — should not throw
    const result = await handle;
    expect(result).toBeNull();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5. timeout + external signal interaction (AbortSignal.any cleanup)
// ---------------------------------------------------------------------------
describe("timeout + external signal interaction", () => {
  it("cancel before timeout does not leave dangling timeout firing later", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const action = defineAction({
      name: "timeout.cancel.before",
      timeout: 5000,
      run: (_a, signal) =>
        new Promise<string>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });
    const handle = action.dispatch("x", { onError });
    // Cancel immediately
    handle.abort();
    const result = await handle;
    expect(result).toBeNull();
    // Advance past the timeout — should not cause any additional errors
    await vi.advanceTimersByTimeAsync(10000);
    expect(onError).not.toHaveBeenCalled(); // cancellation doesn't fire onError
    vi.useRealTimers();
  });

  it("timeout fires correctly with fake timers", async () => {
    vi.useFakeTimers();
    const action = defineAction({
      name: "timeout.fake.timers",
      timeout: 100,
      run: (_a, signal) =>
        new Promise<string>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    });
    const handle = action.dispatch("x");
    await vi.advanceTimersByTimeAsync(150);
    const result = await handle;
    expect(result).toBeNull();
    expect(recentLog().find((e) => e.name === "timeout.fake.timers")?.status).toMatch(
      /error|cancelled/,
    );
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 6. idempotency key reuse across retries
// ---------------------------------------------------------------------------
describe("idempotency key reuse across retries", () => {
  it("uses the SAME idempotency key for all retry attempts", async () => {
    let attempt = 0;
    const keys: string[] = [];
    configureApi({
      fetchFn: async (_url, init) => {
        const hdrs = (init as RequestInit).headers as Record<string, string>;
        keys.push(hdrs["idempotency-key"] ?? "");
        attempt++;
        if (attempt < 3) {
          return new Response(JSON.stringify({ error: "busy" }), { status: 503 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    const action = apiAction<string>({
      name: "idem.retry",
      request: () => ({ method: "POST", path: "/x", body: {} }),
      idempotencyKey: true,
      retry: { count: 3, delay: 0 },
      retryable: (err) => err.status === 503,
    });
    const result = await action.dispatch("x");
    expect(result).toEqual({ ok: true });
    expect(keys.length).toBe(3);
    // All keys must be the same
    expect(keys[0]).toBe(keys[1]);
    expect(keys[1]).toBe(keys[2]);
    expect(keys[0]!.length).toBeGreaterThan(5);
  });
});
