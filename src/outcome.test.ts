// @vitest-environment happy-dom
// DispatchHandle.outcome: the opt-in typed terminal accessor. Verifies the
// three-way discrimination (success / error / cancelled) on every terminal
// path — run, retry, optimistic failure, abort, scope early-cancel, and the
// dedupe-join follower — including the success-null case the legacy
// `TResult | null` resolution cannot distinguish.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetActionFramework } from "./test-helpers/action-test-setup.js";
vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));
import { defineAction } from "./define.js";
import { ActionError } from "./error.js";

beforeEach(() => {
  resetActionFramework();
  vi.clearAllMocks();
});

describe("DispatchHandle.outcome — terminal discrimination", () => {
  it("resolves success with value and attempts on a plain success", async () => {
    const action = defineAction<string, string>({
      name: "outcome.success",
      run: async (args) => `ok:${args}`,
    });
    const h = action.dispatch("a");
    await expect(h.outcome).resolves.toEqual({
      status: "success",
      value: "ok:a",
      attempts: 1,
    });
    await expect(h).resolves.toBe("ok:a");
  });

  it("distinguishes a legitimate null result from failure (success-null)", async () => {
    const action = defineAction<void, null>({
      name: "outcome.null_result",
      run: async () => null,
    });
    const h = action.dispatch();
    // The legacy resolution collapses this with error/cancel...
    await expect(h).resolves.toBeNull();
    // ...the outcome does not.
    await expect(h.outcome).resolves.toEqual({ status: "success", value: null, attempts: 1 });
  });

  it("resolves error with the normalized ActionErrorLike and attempts", async () => {
    const action = defineAction<void, void>({
      name: "outcome.fail",
      error: false,
      run: async () => {
        throw new ActionError("boom", { status: 500, code: "server" });
      },
    });
    const h = action.dispatch();
    await expect(h).resolves.toBeNull();
    const o = await h.outcome;
    expect(o.status).toBe("error");
    if (o.status !== "error") {
      return;
    }
    expect(o.error.message).toBe("boom");
    expect(o.error.code).toBe("server");
    expect(o.attempts).toBe(1);
  });

  it("counts retry attempts on the error outcome", async () => {
    const action = defineAction<void, void>({
      name: "outcome.retry_exhausted",
      error: false,
      retryable: () => true,
      retry: { count: 1, delay: 0 },
      run: async () => {
        throw new ActionError("still down", { status: 503 });
      },
    });
    const o = await action.dispatch().outcome;
    expect(o).toMatchObject({ status: "error", attempts: 2 });
  });

  it("resolves error on an optimistic() throw", async () => {
    const action = defineAction<void, void, void>({
      name: "outcome.optimistic_fail",
      error: false,
      optimistic: () => {
        throw new Error("optimistic exploded");
      },
      run: async () => undefined,
    });
    const o = await action.dispatch().outcome;
    expect(o).toMatchObject({
      status: "error",
      error: { code: "optimistic_failed" },
    });
  });

  it("resolves cancelled on a per-dispatch abort()", async () => {
    const action = defineAction<void, string>({
      name: "outcome.abort",
      error: false,
      run: (_args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });
    const h = action.dispatch();
    h.abort();
    await expect(h).resolves.toBeNull();
    await expect(h.outcome).resolves.toEqual({ status: "cancelled" });
  });

  it("resolves cancelled for a scope-queued dispatch cancelled before start", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const action = defineAction<string, string>({
      name: "outcome.scope_cancel",
      scope: "lane",
      error: false,
      run: async (args, signal) => {
        if (args === "first") {
          await gate;
        }
        if (signal.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        return args;
      },
    });
    const first = action.dispatch("first");
    const queued = action.dispatch("queued");
    action.cancel();
    releaseFirst();
    await expect(queued.outcome).resolves.toEqual({ status: "cancelled" });
    await expect(first.outcome).resolves.toEqual({ status: "cancelled" });
  });
});

describe("DispatchHandle.outcome — dedupe join", () => {
  it("gives the joining dispatch its own success outcome", async () => {
    let release!: (v: string) => void;
    const gate = new Promise<string>((r) => {
      release = r;
    });
    const action = defineAction<void, string>({
      name: "outcome.dedupe_success",
      dedupe: true,
      run: async () => gate,
    });
    const primary = action.dispatch();
    const joiner = action.dispatch();
    release("shared");
    await expect(primary.outcome).resolves.toEqual({
      status: "success",
      value: "shared",
      attempts: 1,
    });
    // The joiner's outcome carries the shared value but no attempts (it
    // observed the primary's run rather than running itself).
    await expect(joiner.outcome).resolves.toEqual({ status: "success", value: "shared" });
  });

  it("gives the joining dispatch its own error outcome", async () => {
    let releaseErr!: () => void;
    const gate = new Promise<never>((_r, reject) => {
      releaseErr = () => {
        reject(new ActionError("shared failure", { code: "shared_fail" }));
      };
    });
    const action = defineAction<void, string>({
      name: "outcome.dedupe_error",
      dedupe: true,
      error: false,
      run: async () => gate,
    });
    const primary = action.dispatch();
    const joiner = action.dispatch();
    releaseErr();
    await expect(primary.outcome).resolves.toMatchObject({
      status: "error",
      error: { code: "shared_fail" },
    });
    await expect(joiner.outcome).resolves.toMatchObject({
      status: "error",
      error: { code: "shared_fail" },
    });
  });
});
