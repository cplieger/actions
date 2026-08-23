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
import { defineAction, _resetForTest as resetDefine, _internalsForTest } from "./define.js";
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

describe("a thrown value that makes toActionError itself throw", () => {
  // toActionError (error.ts) reads `e.message`, so a throwable with a throwing
  // message getter makes runOnce REJECT — the one hole in dispatch()'s
  // resolve-never-reject contract. The caller can handle the handle's
  // rejection; a derived promise dispatch() creates for its own bookkeeping
  // cannot be handled by anyone, so it must not be left unguarded.
  it("rejects only the caller's handle, never an unhandled promise", async () => {
    const boom = new Error("message getter exploded");
    const hostile = new ActionError("placeholder");
    Object.defineProperty(hostile, "message", {
      configurable: true,
      get: (): string => {
        throw boom;
      },
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent): void => {
      unhandled.push(e.reason);
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    try {
      let calls = 0;
      const action = defineAction<{ id: string }, string>({
        name: "toactionerror.throws",
        dedupe: true,
        error: false,
        run: () => (calls++ === 0 ? Promise.reject(hostile) : Promise.resolve("recovered")),
      });

      let caught: unknown;
      await action.dispatch({ id: "a" }).catch((e: unknown) => {
        caught = e;
      });
      expect(caught).toBe(boom);

      // Two macrotask turns: a rejection is reported as unhandled at the end of
      // the turn in which it stayed without a handler.
      await new Promise((r) => {
        setTimeout(r, 0);
      });
      await new Promise((r) => {
        setTimeout(r, 0);
      });
      expect(unhandled).toEqual([]);

      // The rejection escaped before runOnce's own dedupe eviction, so the
      // post-settle backstop is what releases the slot. Without that release
      // every later dispatch of this key would join a rejected promise forever.
      expect(_internalsForTest().activeDedupes).toBe(0);
      await expect(action.dispatch({ id: "a" })).resolves.toBe("recovered");
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
    }
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
