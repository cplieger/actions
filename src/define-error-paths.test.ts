// The two error paths that bypass run(): an optimistic() that throws, and an
// error-notification formatter that throws. Plus the retry button's args
// handling for a throwable that structuredClone refuses to copy.
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
import { ActionError, retryNetwork } from "./error.js";
import * as notifier from "./notifier.js";

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
  vi.clearAllMocks();
});

describe("optimistic() throws", () => {
  it("keeps the error's own code instead of relabelling it optimistic_failed", async () => {
    const action = defineAction<void, string, string>({
      name: "optimistic.coded_throw",
      error: false,
      optimistic: () => {
        throw new ActionError("no room", { code: "quota_exceeded" });
      },
      run: async () => "unreachable",
    });

    const h = action.dispatch();
    await expect(h.outcome).resolves.toEqual({
      status: "error",
      error: { message: "no room", code: "quota_exceeded" },
    });
  });

  it("labels an uncoded failure optimistic_failed", async () => {
    const action = defineAction<void, string, string>({
      name: "optimistic.uncoded_throw",
      error: false,
      optimistic: () => {
        throw new Error("snapshot failed");
      },
      run: async () => "unreachable",
    });

    const h = action.dispatch();
    await expect(h.outcome).resolves.toMatchObject({
      status: "error",
      error: { message: "snapshot failed", code: "optimistic_failed" },
    });
  });

  it("fires the error and settled callbacks exactly once", async () => {
    const defError = vi.fn();
    const defSettled = vi.fn();
    const optError = vi.fn();
    const optSettled = vi.fn();
    const action = defineAction<void, string, string>({
      name: "optimistic.callbacks",
      error: false,
      optimistic: () => {
        throw new ActionError("nope", { code: "quota_exceeded" });
      },
      onError: defError,
      onSettled: defSettled,
      run: async () => "unreachable",
    });

    await action.dispatch(undefined, { onError: optError, onSettled: optSettled });

    expect(defError).toHaveBeenCalledTimes(1);
    expect(optError).toHaveBeenCalledTimes(1);
    expect(defSettled).toHaveBeenCalledTimes(1);
    expect(optSettled).toHaveBeenCalledTimes(1);
  });
});

describe("error notification formatter throws", () => {
  it("still notifies, using the default '<Verb> failed: <message>' text", async () => {
    const action = defineAction<void, string>({
      name: "chat.delete",
      error: () => {
        throw new Error("formatter broken");
      },
      run: () => Promise.reject(new ActionError("server said no")),
    });

    await action.dispatch();

    expect(vi.mocked(notifier.notifyError)).toHaveBeenCalledWith(
      "Delete failed: server said no",
      undefined,
    );
  });
});

describe("retry button args for a non-cloneable throwable", () => {
  it("re-dispatches the identical function args structuredClone could not copy", async () => {
    const seen: unknown[] = [];
    const callback = (): string => "payload";
    const action = defineAction<() => string, string>({
      name: "retrybutton.fn_args",
      retryable: retryNetwork,
      run: (args) => {
        seen.push(args);
        return Promise.reject(new ActionError("offline", { status: 0 }));
      },
    });

    await action.dispatch(callback);

    const retry = vi.mocked(notifier.notifyError).mock.calls[0]?.[1]?.onClick;
    expect(retry).toBeDefined();
    retry?.();
    await vi.waitFor(() => {
      expect(seen).toHaveLength(2);
    });

    expect(seen[1]).toBe(callback);
  });
});
