// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetActionFramework } from "./__test-helpers__/action-test-setup.js";

vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));

import { defineAction } from "./define.js";
import { ActionError, retryNetwork } from "./error.js";
import { recentLog, subscribe, pendingCount } from "./registry.js";
import * as notifier from "./notifier.js";

beforeEach(() => {
  resetActionFramework();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("defineAction — happy path", () => {
  it("dispatch resolves with the run() result", async () => {
    const action = defineAction({
      name: "test.echo",
      run: async (args: { msg: string }) => args.msg,
    });
    expect(await action.dispatch({ msg: "hello" })).toBe("hello");
  });

  it("records pending then success in the registry", async () => {
    const action = defineAction({ name: "test.ok", run: async () => "done" });
    const events: string[] = [];
    const unsub = subscribe((i) => {
      events.push(i.status);
    });
    await action.dispatch({});
    unsub();
    expect(events).toEqual(["pending", "success"]);
    const log = recentLog();
    expect(log[0]?.status).toBe("success");
    expect(log[0]?.result).toBe("done");
  });

  it("does not notify on success by default", async () => {
    const action = defineAction({ name: "test.silent_success", run: async () => "x" });
    await action.dispatch({});
    expect(notifier.notifySuccess).not.toHaveBeenCalled();
  });

  it("notifies on success when `success` is a string", async () => {
    const action = defineAction({
      name: "test.success_string",
      run: async () => "x",
      success: "Saved",
    });
    await action.dispatch({});
    expect(notifier.notifySuccess).toHaveBeenCalledWith("Saved");
  });

  it("notifies on success when `success` is a function", async () => {
    const action = defineAction({
      name: "test.success_fn",
      run: async (args: string) => `${args}!`,
      success: (args, result) => `Got ${result} for ${args}`,
    });
    await action.dispatch("hi");
    expect(notifier.notifySuccess).toHaveBeenCalledWith("Got hi! for hi");
  });

  it("dispatch({ silent: true }) suppresses success notification", async () => {
    const action = defineAction({ name: "test.silenced", run: async () => "x", success: "Saved" });
    await action.dispatch({}, { silent: true });
    expect(notifier.notifySuccess).not.toHaveBeenCalled();
  });
});

describe("defineAction — error path", () => {
  it("dispatch resolves to null on run() throw", async () => {
    const action = defineAction({
      name: "test.fail",
      run: async () => {
        throw new ActionError("boom");
      },
    });
    expect(await action.dispatch({})).toBeNull();
  });

  it("records error status with the error message", async () => {
    const action = defineAction({
      name: "test.error",
      run: async () => {
        throw new ActionError("bad", { status: 500 });
      },
    });
    await action.dispatch({});
    const log = recentLog();
    expect(log[0]?.status).toBe("error");
    expect(log[0]?.error?.message).toBe("bad");
    expect(log[0]?.error?.status).toBe(500);
  });

  it("notifies on error by default with the action-name prefix", async () => {
    const action = defineAction({
      name: "chat.delete",
      run: async () => {
        throw new ActionError("not found");
      },
    });
    await action.dispatch({});
    expect(notifier.notifyError).toHaveBeenCalledWith("Delete failed: not found", undefined);
  });

  it("`error: 'Custom prefix'` becomes the notification prefix", async () => {
    const action = defineAction({
      name: "test.fail",
      run: async () => {
        throw new ActionError("nope");
      },
      error: "Couldn't do the thing",
    });
    await action.dispatch({});
    expect(notifier.notifyError).toHaveBeenCalledWith("Couldn't do the thing: nope", undefined);
  });

  it("`error: false` suppresses the error notification", async () => {
    const action = defineAction({
      name: "test.no_toast",
      run: async () => {
        throw new ActionError("silent");
      },
      error: false,
    });
    await action.dispatch({});
    expect(notifier.notifyError).not.toHaveBeenCalled();
  });

  it("normalises non-ActionError throws", async () => {
    const action = defineAction({
      name: "test.weird",
      run: async () => {
        throw "string";
      },
    });
    await action.dispatch({});
    expect(recentLog()[0]?.error?.message).toBe("string");
  });
});

describe("defineAction — optimistic + rollback", () => {
  it("calls optimistic before run() with args", async () => {
    const order: string[] = [];
    const action = defineAction({
      name: "test.opt",
      optimistic: () => {
        order.push("opt");
        return undefined;
      },
      run: async () => {
        order.push("run");
        return undefined;
      },
    });
    await action.dispatch({});
    expect(order).toEqual(["opt", "run"]);
  });

  it("rollback receives the TOp on error", async () => {
    const rollback = vi.fn();
    const action = defineAction({
      name: "test.rollback",
      optimistic: () => ({ undoToken: 42 }),
      rollback,
      run: async () => {
        throw new ActionError("fail");
      },
    });
    await action.dispatch({ id: "x" });
    expect(rollback).toHaveBeenCalledWith(
      { id: "x" },
      { undoToken: 42 },
      expect.objectContaining({ message: "fail" }),
    );
  });

  it("rollback NOT called on success", async () => {
    const rollback = vi.fn();
    const action = defineAction({
      name: "test.no_rollback",
      optimistic: () => ({ x: 1 }),
      rollback,
      run: async () => "ok",
    });
    await action.dispatch({});
    expect(rollback).not.toHaveBeenCalled();
  });

  it("optimistic throwing skips run() and notifies the error", async () => {
    const run = vi.fn();
    const action = defineAction({
      name: "test.opt_throw",
      optimistic: () => {
        throw new Error("optimistic broke");
      },
      run: async () => {
        run();
        return "x";
      },
    });
    await action.dispatch({});
    expect(run).not.toHaveBeenCalled();
    expect(notifier.notifyError).toHaveBeenCalled();
  });

  it("rollback exception is logged but doesn't crash", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const action = defineAction({
      name: "test.rollback_throw",
      optimistic: () => ({}),
      rollback: () => {
        throw new Error("rollback broke");
      },
      run: async () => {
        throw new ActionError("run failed");
      },
    });
    await action.dispatch({});
    expect(consoleErr).toHaveBeenCalled();
    expect(notifier.notifyError).toHaveBeenCalled();
    consoleErr.mockRestore();
  });
});

describe("defineAction — cancellation", () => {
  it("action.cancel() aborts the run()'s signal", async () => {
    let aborted = false;
    const action = defineAction({
      name: "test.cancel",
      run: async (_args, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });
    const p = action.dispatch({});
    action.cancel();
    expect(await p).toBeNull();
    expect(aborted).toBe(true);
  });

  it("cancel records 'cancelled' status, not 'error'", async () => {
    const action = defineAction({
      name: "test.cancel_status",
      run: (_args, signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    });
    const p = action.dispatch({});
    action.cancel();
    await p;
    const log = recentLog();
    expect(log[log.length - 1]?.status).toBe("cancelled");
  });

  it("cancel still calls rollback to undo optimistic", async () => {
    const rollback = vi.fn();
    const action = defineAction({
      name: "test.cancel_rollback",
      optimistic: () => ({ token: "abc" }),
      rollback,
      run: (_args, signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    });
    const p = action.dispatch({});
    action.cancel();
    await p;
    expect(rollback).toHaveBeenCalled();
  });

  it("cancel does NOT notify (cancellation is user-initiated)", async () => {
    const action = defineAction({
      name: "test.cancel_no_toast",
      run: (_args, signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
      error: "Should not appear",
    });
    const p = action.dispatch({});
    action.cancel();
    await p;
    expect(notifier.notifyError).not.toHaveBeenCalled();
  });
});

describe("defineAction — concurrent instances", () => {
  it("each dispatch gets a unique id", async () => {
    const action = defineAction({ name: "test.multi", run: async () => "x" });
    await Promise.all([action.dispatch({}), action.dispatch({}), action.dispatch({})]);
    const ids = recentLog().map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("cancel() aborts all in-flight instances", async () => {
    const aborts: number[] = [];
    let i = 0;
    const action = defineAction({
      name: "test.multi_cancel",
      run: (_args, signal) => {
        const me = ++i;
        return new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => {
            aborts.push(me);
            reject(new Error("aborted"));
          });
        });
      },
    });
    const ps = [action.dispatch({}), action.dispatch({}), action.dispatch({})];
    action.cancel();
    await Promise.all(ps);
    expect(aborts.sort()).toEqual([1, 2, 3]);
  });
});

describe("registry", () => {
  it("recentLog is bounded", async () => {
    const action = defineAction({ name: "test.bounded", run: async () => "x" });
    for (let i = 0; i < 250; i++) {
      await action.dispatch({});
    }
    expect(recentLog().length).toBe(200);
  });

  it("subscriber unsubscribes cleanly", async () => {
    const action = defineAction({ name: "test.unsub", run: async () => "x" });
    let calls = 0;
    const unsub = subscribe(() => {
      calls += 1;
    });
    await action.dispatch({});
    const after1 = calls;
    unsub();
    await action.dispatch({});
    expect(calls).toBe(after1);
  });
});

describe("pendingCount — public API", () => {
  it("reports 1 for the named action mid-flight, 0 after completion", async () => {
    let resolve!: () => void;
    const action = defineAction({
      name: "test.slow",
      run: () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    });
    const p = action.dispatch({});
    expect(pendingCount(["test.slow"])).toBe(1);
    resolve();
    await p;
    expect(pendingCount(["test.slow"])).toBe(0);
  });
});

describe("defineAction — retryable error notification", () => {
  it("retryable passes a retry handler to error notification", async () => {
    const action = defineAction({
      name: "test.retry_always",
      run: async () => {
        throw new ActionError("network glitch");
      },
      retryable: (err) => err.code !== "cancelled",
    });
    await action.dispatch({ id: 1 });
    expect(notifier.notifyError).toHaveBeenCalledTimes(1);
    const args = vi.mocked(notifier.notifyError).mock.calls[0]!;
    expect(args[1]).toBeDefined();
    expect(typeof args[1]?.onClick).toBe("function");
  });

  it("retryable: 'network' includes retry for status 0 / timeout", async () => {
    const a1 = defineAction({
      name: "test.retry_net_status0",
      run: async () => {
        throw new ActionError("fetch failed", { status: 0 });
      },
      retryable: retryNetwork,
    });
    await a1.dispatch({});
    expect(vi.mocked(notifier.notifyError).mock.calls[0]?.[1]).toBeDefined();
    vi.clearAllMocks();
    const a2 = defineAction({
      name: "test.retry_net_timeout",
      run: async () => {
        throw new ActionError("Request timed out", { code: "timeout" });
      },
      retryable: retryNetwork,
    });
    await a2.dispatch({});
    expect(vi.mocked(notifier.notifyError).mock.calls[0]?.[1]).toBeDefined();
  });

  it("retryable: 'network' suppresses retry for HTTP 4xx/5xx", async () => {
    const action = defineAction({
      name: "test.retry_net_4xx",
      run: async () => {
        throw new ActionError("not found", { status: 404 });
      },
      retryable: retryNetwork,
    });
    await action.dispatch({});
    expect(vi.mocked(notifier.notifyError).mock.calls[0]?.[1]).toBeUndefined();
  });

  it("retryable: false (default) never includes retry", async () => {
    const action = defineAction({
      name: "test.retry_default",
      run: async () => {
        throw new ActionError("oops");
      },
    });
    await action.dispatch({});
    expect(vi.mocked(notifier.notifyError).mock.calls[0]?.[1]).toBeUndefined();
  });

  it("retry handler re-dispatches the same action with the same args", async () => {
    let attempts = 0;
    const action = defineAction({
      name: "test.retry_redispatch",
      run: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new ActionError("first", { status: 0 });
        }
        return "ok";
      },
      retryable: retryNetwork,
    });
    await action.dispatch({ msg: "hello" });
    const retryFn = vi.mocked(notifier.notifyError).mock.calls[0]?.[1]?.onClick as () => void;
    expect(retryFn).toBeDefined();
    retryFn();
    await vi.waitFor(() => {
      expect(attempts).toBe(2);
    });
  });

  it("retry suppressed when error: false (no notification at all)", async () => {
    const action = defineAction({
      name: "test.retry_no_toast",
      run: async () => {
        throw new ActionError("silent");
      },
      error: false,
      retryable: (err) => err.code !== "cancelled",
    });
    await action.dispatch({});
    expect(notifier.notifyError).not.toHaveBeenCalled();
  });
});

describe("defineAction — deduped joiner fires definition-level callbacks", () => {
  it("joiner fires def-level onSuccess before its own per-call onSuccess", async () => {
    const defOnSuccess = vi.fn();
    const defOnSettled = vi.fn();
    const joinerOnSuccess = vi.fn();
    const action = defineAction<string, string>({
      name: "test.dedupe_join_success",
      dedupe: true,
      onSuccess: defOnSuccess,
      onSettled: defOnSettled,
      run: async () => "shared-result",
    });
    // Two concurrent dispatches with the same key: the second joins the first.
    const originator = action.dispatch("k");
    const joiner = action.dispatch("k", { onSuccess: joinerOnSuccess });
    const [r1, r2] = await Promise.all([originator, joiner]);
    expect(r1).toBe("shared-result");
    expect(r2).toBe("shared-result");
    // Both the originator AND the joiner fire the definition-level callbacks
    // (pre-fix the joiner fired only its per-call callbacks, so this was 1).
    expect(defOnSuccess).toHaveBeenCalledTimes(2);
    expect(defOnSuccess).toHaveBeenCalledWith("shared-result", "k");
    expect(defOnSettled).toHaveBeenCalledTimes(2);
    expect(joinerOnSuccess).toHaveBeenCalledTimes(1);
    // The joiner's def-level firing (the 2nd def call) precedes its per-call.
    expect(defOnSuccess.mock.invocationCallOrder[1]!).toBeLessThan(
      joinerOnSuccess.mock.invocationCallOrder[0]!,
    );
  });

  it("joiner fires def-level onError before its own per-call onError", async () => {
    const defOnError = vi.fn();
    const defOnSettled = vi.fn();
    const joinerOnError = vi.fn();
    const action = defineAction<string, string>({
      name: "test.dedupe_join_error",
      dedupe: true,
      error: false,
      onError: defOnError,
      onSettled: defOnSettled,
      run: async () => {
        throw new ActionError("boom");
      },
    });
    const originator = action.dispatch("k");
    const joiner = action.dispatch("k", { onError: joinerOnError });
    await Promise.all([originator, joiner]);
    expect(defOnError).toHaveBeenCalledTimes(2);
    expect(defOnError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }), "k");
    expect(defOnSettled).toHaveBeenCalledTimes(2);
    expect(joinerOnError).toHaveBeenCalledTimes(1);
    expect(defOnError.mock.invocationCallOrder[1]!).toBeLessThan(
      joinerOnError.mock.invocationCallOrder[0]!,
    );
  });

  it("joiner treats an explicit null-result success as success, not a synthetic error", async () => {
    const defOnSuccess = vi.fn();
    const defOnError = vi.fn();
    const joinerOnSuccess = vi.fn();
    const joinerOnError = vi.fn();
    const action = defineAction<string, string | null>({
      name: "test.dedupe_join_null_success",
      dedupe: true,
      onSuccess: defOnSuccess,
      onError: defOnError,
      run: async () => null,
    });
    const originator = action.dispatch("k");
    const joiner = action.dispatch("k", {
      onSuccess: joinerOnSuccess,
      onError: joinerOnError,
    });
    await Promise.all([originator, joiner]);
    // A null result is a legitimate success; the joiner must not synthesise a
    // "deduped dispatch did not succeed" error from it.
    expect(defOnSuccess).toHaveBeenCalledTimes(2);
    expect(defOnSuccess).toHaveBeenCalledWith(null, "k");
    expect(joinerOnSuccess).toHaveBeenCalledTimes(1);
    expect(joinerOnSuccess).toHaveBeenCalledWith(null, "k");
    expect(defOnError).not.toHaveBeenCalled();
    expect(joinerOnError).not.toHaveBeenCalled();
  });
});

describe("defineAction — deduped joiner of a cancelled dispatch", () => {
  it("joiner of a cancelled deduped dispatch fires only onSettled (no success/error)", async () => {
    const defOnSuccess = vi.fn();
    const defOnError = vi.fn();
    const defOnSettled = vi.fn();
    const joinerOnSuccess = vi.fn();
    const joinerOnError = vi.fn();
    const joinerOnSettled = vi.fn();
    const action = defineAction<string, string>({
      name: "test.dedupe_join_cancelled",
      dedupe: true,
      error: false,
      onSuccess: defOnSuccess,
      onError: defOnError,
      onSettled: defOnSettled,
      run: (_args, signal) =>
        new Promise<string>((resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
          setTimeout(() => {
            resolve("late");
          }, 10);
        }),
    });
    const originator = action.dispatch("k");
    const joiner = action.dispatch("k", {
      onSuccess: joinerOnSuccess,
      onError: joinerOnError,
      onSettled: joinerOnSettled,
    });
    action.cancel();
    const [r1, r2] = await Promise.all([originator, joiner]);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    // A joiner attached to a dispatch that is then cancelled must settle
    // silently: it fires neither onSuccess nor the synthetic "deduped dispatch
    // did not succeed" onError, only onSettled.
    expect(joinerOnSuccess).not.toHaveBeenCalled();
    expect(joinerOnError).not.toHaveBeenCalled();
    expect(joinerOnSettled).toHaveBeenCalledTimes(1);
    expect(defOnSuccess).not.toHaveBeenCalled();
    expect(defOnError).not.toHaveBeenCalled();
  });
});
