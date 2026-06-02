// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("./notifier.js", () => ({ configure: vi.fn(), notifySuccess: vi.fn(), notifyError: vi.fn(), _resetNotifierForTest: vi.fn() }));
import { defineAction, _resetForTest as resetDefine } from "./define.js";
import { _resetForTest as resetRegistry } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";
import { ActionError, retryNetwork } from "./error.js";

beforeEach(() => { resetDefine(); resetRegistry(); resetCleanup(); vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe("defineAction retry { count, delay, factor }", () => {
  it("retries up to count times on retry-class errors then succeeds", async () => {
    let attempts = 0;
    const action = defineAction<{ id: string }, string>({ name: "test.retry_recovers", retryable: retryNetwork, retry: { count: 2, delay: 100 }, run: () => { attempts++; if (attempts < 3) { throw new ActionError("flaky", { code: "network" }); } return Promise.resolve("ok"); } });
    const promise = action.dispatch({ id: "x" });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    expect(await promise).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("returns null after exhausting retries", async () => {
    let attempts = 0;
    const action = defineAction<void, void>({ name: "test.retry_exhausts", retryable: retryNetwork, retry: { count: 2, delay: 50 }, error: false, run: () => { attempts++; return Promise.reject(new ActionError("permanent network fail", { code: "network" })); } });
    const promise = action.dispatch();
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(100);
    expect(await promise).toBeNull();
    expect(attempts).toBe(3);
  });

  it("does NOT retry non-retry-class errors even with retry config", async () => {
    let attempts = 0;
    const action = defineAction<void, void>({ name: "test.retry_skips_4xx", retryable: retryNetwork, retry: { count: 3, delay: 50 }, error: false, run: () => { attempts++; return Promise.reject(new ActionError("validation", { status: 422 })); } });
    await action.dispatch();
    expect(attempts).toBe(1);
  });

  it("aborts retry chain if action.cancel() during backoff", async () => {
    let attempts = 0;
    const action = defineAction<void, void>({ name: "test.retry_cancel_mid_backoff", retryable: retryNetwork, retry: { count: 5, delay: 1000 }, error: false, run: () => { attempts++; return Promise.reject(new ActionError("fail", { code: "network" })); } });
    const promise = action.dispatch();
    await vi.advanceTimersByTimeAsync(50);
    action.cancel();
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
    expect(attempts).toBe(1);
  });
});

describe("defineAction scope (serial dispatch)", () => {
  it("serializes dispatches sharing a static scope string", async () => {
    const log: string[] = [];
    const action = defineAction<{ tag: string }, string>({ name: "test.scope_static", scope: "shared", run: async (args) => { log.push(`start:${args.tag}`); await new Promise<void>((r) => setTimeout(r, 50)); log.push(`end:${args.tag}`); return args.tag; } });
    const p1 = action.dispatch({ tag: "A" });
    const p2 = action.dispatch({ tag: "B" });
    const p3 = action.dispatch({ tag: "C" });
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([p1, p2, p3]);
    expect(log).toEqual(["start:A", "end:A", "start:B", "end:B", "start:C", "end:C"]);
  });

  it("scope queue continues after a failed dispatch", async () => {
    const log: string[] = [];
    const action = defineAction<{ tag: string; fail: boolean }, void>({ name: "test.scope_after_fail", scope: "q", error: false, run: async (args) => { log.push(`run:${args.tag}`); if (args.fail) { throw new ActionError("nope"); } } });
    const p1 = action.dispatch({ tag: "A", fail: true });
    const p2 = action.dispatch({ tag: "B", fail: false });
    await Promise.all([p1, p2]);
    expect(log).toEqual(["run:A", "run:B"]);
  });
});

describe("DispatchOptions onSuccess / onError / onSettled", () => {
  it("onSuccess fires with result + args", async () => {
    const action = defineAction<{ x: number }, number>({ name: "test.cb_success", run: (args) => Promise.resolve(args.x * 2) });
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onSettled = vi.fn();
    await action.dispatch({ x: 21 }, { onSuccess, onError, onSettled });
    expect(onSuccess).toHaveBeenCalledWith(42, { x: 21 });
    expect(onError).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledWith({ x: 21 });
  });

  it("onError fires with error + args", async () => {
    const action = defineAction<{ tag: string }, void>({ name: "test.cb_error", error: false, run: () => Promise.reject(new ActionError("nope", { status: 422 })) });
    const onError = vi.fn();
    const onSettled = vi.fn();
    await action.dispatch({ tag: "z" }, { onError, onSettled });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "nope", status: 422 }), { tag: "z" });
    expect(onSettled).toHaveBeenCalledWith({ tag: "z" });
  });

  it("onSettled fires on cancellation; onSuccess/onError do NOT", async () => {
    const action = defineAction<void, void>({ name: "test.cb_cancel", run: (_args, signal) => new Promise<void>((_, reject) => { signal.addEventListener("abort", () => { reject(new Error("cancelled")); }); }) });
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onSettled = vi.fn();
    const promise = action.dispatch(undefined, { onSuccess, onError, onSettled });
    action.cancel();
    await promise;
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
