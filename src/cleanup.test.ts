// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetActionFramework } from "./__test-helpers__/action-test-setup.js";
vi.mock("./notifier.js", () => ({ configure: vi.fn(), notifySuccess: vi.fn(), notifyError: vi.fn(), _resetNotifierForTest: vi.fn() }));
import { defineAction } from "./define.js";
import { registerCleanup, _cancelAllForTest as cancelAllPending } from "./cleanup.js";

beforeEach(() => { resetActionFramework(); vi.clearAllMocks(); });

describe("cancelAllPending + registered cleanup", () => {
  it("aborts in-flight action via action.cancel() on global cleanup", async () => {
    let aborted = false;
    const action = defineAction({ name: "test.cleanup1", run: (_args, signal) => new Promise<void>((_, reject) => { signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }); }) });
    const p = action.dispatch({});
    cancelAllPending();
    await p;
    expect(aborted).toBe(true);
  });

  it("invokes registered cleanup hooks", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    registerCleanup(fn1);
    registerCleanup(fn2);
    cancelAllPending();
    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();
  });

  it("returns an unregister function for cleanup hooks", () => {
    const fn = vi.fn();
    const unreg = registerCleanup(fn);
    unreg();
    cancelAllPending();
    expect(fn).not.toHaveBeenCalled();
  });

  it("a throwing cleanup hook does not stop other hooks", () => {
    const fn1 = vi.fn(() => { throw new Error("bad"); });
    const fn2 = vi.fn();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    registerCleanup(fn1);
    registerCleanup(fn2);
    cancelAllPending();
    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();
    consoleErr.mockRestore();
  });

  it("cancels multiple actions and runs hooks in one cancelAllPending call", async () => {
    let abort1 = false;
    let abort2 = false;
    const a1 = defineAction({ name: "test.cleanup-multi-1", run: (_args, signal) => new Promise<void>((_, reject) => { signal.addEventListener("abort", () => { abort1 = true; reject(new Error("aborted")); }); }) });
    const a2 = defineAction({ name: "test.cleanup-multi-2", run: (_args, signal) => new Promise<void>((_, reject) => { signal.addEventListener("abort", () => { abort2 = true; reject(new Error("aborted")); }); }) });
    const hook = vi.fn();
    registerCleanup(hook);
    const p1 = a1.dispatch({});
    const p2 = a2.dispatch({});
    cancelAllPending();
    await Promise.all([p1, p2]);
    expect(abort1).toBe(true);
    expect(abort2).toBe(true);
    expect(hook).toHaveBeenCalledOnce();
  });
});
