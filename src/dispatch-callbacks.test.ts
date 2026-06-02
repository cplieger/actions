// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));
import { defineAction, _resetForTest as resetDefine } from "./define.js";
import { _resetForTest as resetRegistry } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";
import { ActionError } from "./error.js";

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
});

describe("dispatch callbacks — onSuccess", () => {
  it("fires with result and args on success", async () => {
    const onSuccess = vi.fn();
    const action = defineAction({ name: "cb.ok", run: async (n: number) => n * 2 });
    await action.dispatch(5, { onSuccess });
    expect(onSuccess).toHaveBeenCalledWith(10, 5);
  });

  it("does not fire on error", async () => {
    const onSuccess = vi.fn();
    const action = defineAction({
      name: "cb.fail",
      run: async () => {
        throw new ActionError("nope");
      },
    });
    await action.dispatch({}, { onSuccess });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("throwing in onSuccess is caught and logged", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const action = defineAction({ name: "cb.throw", run: async () => "ok" });
    const result = await action.dispatch(
      {},
      {
        onSuccess: () => {
          throw new Error("callback boom");
        },
      },
    );
    expect(result).toBe("ok");
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });
});

describe("dispatch callbacks — onError", () => {
  it("fires with error and args on failure", async () => {
    const onError = vi.fn();
    const action = defineAction({
      name: "cb.err",
      run: async () => {
        throw new ActionError("bad", { status: 500 });
      },
    });
    await action.dispatch("arg", { onError });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "bad", status: 500 }),
      "arg",
    );
  });

  it("does not fire on cancellation", async () => {
    const onError = vi.fn();
    const action = defineAction({
      name: "cb.cancel",
      run: (_args, signal) =>
        new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    });
    const p = action.dispatch({}, { onError });
    action.cancel();
    await p;
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("dispatch callbacks — onSettled", () => {
  it("fires on success", async () => {
    const onSettled = vi.fn();
    const action = defineAction({ name: "cb.settled.ok", run: async () => "x" });
    await action.dispatch("a", { onSettled });
    expect(onSettled).toHaveBeenCalledWith("a");
  });

  it("fires on error", async () => {
    const onSettled = vi.fn();
    const action = defineAction({
      name: "cb.settled.err",
      run: async () => {
        throw new ActionError("fail");
      },
    });
    await action.dispatch("b", { onSettled });
    expect(onSettled).toHaveBeenCalledWith("b");
  });

  it("fires on cancellation", async () => {
    const onSettled = vi.fn();
    const action = defineAction({
      name: "cb.settled.cancel",
      run: (_args, signal) =>
        new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    });
    const p = action.dispatch("c", { onSettled });
    action.cancel();
    await p;
    expect(onSettled).toHaveBeenCalledWith("c");
  });

  it("fires even when onSuccess callback throws", async () => {
    const onSettled = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const action = defineAction({ name: "cb.settled.throw-success", run: async () => "ok" });
    await action.dispatch("d", {
      onSuccess: () => {
        throw new Error("onSuccess boom");
      },
      onSettled,
    });
    expect(onSettled).toHaveBeenCalledWith("d");
    vi.mocked(console.error).mockRestore();
  });
});
