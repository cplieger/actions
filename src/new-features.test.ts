// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("./notifier.js", () => ({ configure: vi.fn(), notifySuccess: vi.fn(), notifyError: vi.fn(), _resetNotifierForTest: vi.fn() }));
import { defineAction, _resetForTest as resetDefine } from "./define.js";
import { _resetForTest as resetRegistry, subscribeByName, getActionLog } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";
import { ActionError } from "./error.js";

beforeEach(() => { resetDefine(); resetRegistry(); resetCleanup(); });

// ---------------------------------------------------------------------------
// 1. Definition-level onSuccess / onError / onSettled (TanStack pattern)
// ---------------------------------------------------------------------------
describe("definition-level callbacks (TanStack pattern)", () => {
  it("onSuccess fires on every successful dispatch", async () => {
    const defOnSuccess = vi.fn();
    const action = defineAction({ name: "def.ok", run: async (n: number) => n * 3, onSuccess: defOnSuccess });
    await action.dispatch(2);
    await action.dispatch(4);
    expect(defOnSuccess).toHaveBeenCalledTimes(2);
    expect(defOnSuccess).toHaveBeenCalledWith(6, 2);
    expect(defOnSuccess).toHaveBeenCalledWith(12, 4);
  });

  it("onError fires on every failed dispatch", async () => {
    const defOnError = vi.fn();
    const action = defineAction({ name: "def.err", run: async () => { throw new ActionError("boom"); }, onError: defOnError });
    await action.dispatch("x");
    expect(defOnError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }), "x");
  });

  it("onError does NOT fire on cancellation", async () => {
    const defOnError = vi.fn();
    const action = defineAction({
      name: "def.cancel-no-err",
      run: (_a, signal) => new Promise<void>((_, rej) => { signal.addEventListener("abort", () => rej(new Error("aborted"))); }),
      onError: defOnError,
    });
    const p = action.dispatch("a");
    action.cancel();
    await p;
    expect(defOnError).not.toHaveBeenCalled();
  });

  it("onSettled fires on success, error, and cancellation", async () => {
    const defOnSettled = vi.fn();
    const okAction = defineAction({ name: "def.settled.ok", run: async () => "r", onSettled: defOnSettled });
    await okAction.dispatch("s");
    expect(defOnSettled).toHaveBeenCalledWith("s");

    defOnSettled.mockClear();
    const errAction = defineAction({ name: "def.settled.err", run: async () => { throw new ActionError("e"); }, onSettled: defOnSettled });
    await errAction.dispatch("e");
    expect(defOnSettled).toHaveBeenCalledWith("e");

    defOnSettled.mockClear();
    const cancelAction = defineAction({
      name: "def.settled.cancel",
      run: (_a, signal) => new Promise<void>((_, rej) => { signal.addEventListener("abort", () => rej(new Error("aborted"))); }),
      onSettled: defOnSettled,
    });
    const p = cancelAction.dispatch("c");
    cancelAction.cancel();
    await p;
    expect(defOnSettled).toHaveBeenCalledWith("c");
  });

  it("definition-level fires BEFORE per-dispatch callbacks", async () => {
    const order: string[] = [];
    const action = defineAction({
      name: "def.order",
      run: async () => "ok",
      onSuccess: () => { order.push("def"); },
    });
    await action.dispatch("a", { onSuccess: () => { order.push("dispatch"); } });
    expect(order).toEqual(["def", "dispatch"]);
  });

  it("throwing in definition-level callback is caught", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const action = defineAction({
      name: "def.throw",
      run: async () => "ok",
      onSuccess: () => { throw new Error("def boom"); },
    });
    const result = await action.dispatch("a");
    expect(result).toBe("ok");
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 2. Per-dispatch abort handle (RTK pattern)
// ---------------------------------------------------------------------------
describe("per-dispatch abort handle (RTK pattern)", () => {
  it("dispatch() returns a DispatchHandle with abort()", () => {
    const action = defineAction({ name: "handle.shape", run: async () => "ok" });
    const handle = action.dispatch("a");
    expect(handle).toBeInstanceOf(Promise);
    expect(typeof handle.abort).toBe("function");
  });

  it("abort() cancels only the specific dispatch", async () => {
    const resolvers: ((v: string) => void)[] = [];
    const action = defineAction({
      name: "handle.specific",
      run: (_args, signal) => new Promise<string>((resolve, reject) => {
        resolvers.push(resolve);
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    });
    const h1 = action.dispatch("a");
    const h2 = action.dispatch("b");
    // Wait for both run() calls to register
    await new Promise((r) => setTimeout(r, 10));
    h1.abort();
    resolvers[1]!("two");
    const [r1, r2] = await Promise.all([h1, h2]);
    expect(r1).toBeNull(); // aborted
    expect(r2).toBe("two"); // unaffected
  });

  it("abort() after completion is a no-op", async () => {
    const action = defineAction({ name: "handle.noop", run: async () => "done" });
    const handle = action.dispatch("a");
    const result = await handle;
    handle.abort(); // should not throw
    expect(result).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// 3. timeout option on ActionDefinition
// ---------------------------------------------------------------------------
describe("timeout option on ActionDefinition", () => {
  it("aborts run() after timeout ms", async () => {
    const action = defineAction({
      name: "timeout.expire",
      timeout: 50,
      run: (_args, signal) => new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => resolve("late"), 200);
        signal.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); });
      }),
    });
    const result = await action.dispatch("x");
    expect(result).toBeNull(); // timed out
  });

  it("does not abort if run() completes within timeout", async () => {
    const action = defineAction({
      name: "timeout.ok",
      timeout: 500,
      run: async () => "fast",
    });
    const result = await action.dispatch("x");
    expect(result).toBe("fast");
  });
});

// ---------------------------------------------------------------------------
// 4. subscribeByName + getActionLog public exports
// ---------------------------------------------------------------------------
describe("subscribeByName (public API)", () => {
  it("receives events only for the named action", async () => {
    const events: string[] = [];
    subscribeByName("sub.target", (inst) => { events.push(inst.status); });
    const target = defineAction({ name: "sub.target", run: async () => "ok" });
    const other = defineAction({ name: "sub.other", run: async () => "ok" });
    await target.dispatch("a");
    await other.dispatch("b");
    expect(events).toEqual(["pending", "success"]);
  });

  it("unsubscribe stops events", async () => {
    const events: string[] = [];
    const unsub = subscribeByName("sub.unsub", (inst) => { events.push(inst.status); });
    const action = defineAction({ name: "sub.unsub", run: async () => "ok" });
    await action.dispatch("a");
    unsub();
    await action.dispatch("b");
    expect(events).toEqual(["pending", "success"]);
  });
});

describe("getActionLog (public API)", () => {
  it("returns recent action instances", async () => {
    const action = defineAction({ name: "log.test", run: async () => "r" });
    await action.dispatch("a");
    const log = getActionLog();
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log.some((e) => e.name === "log.test" && e.status === "success")).toBe(true);
  });
});
