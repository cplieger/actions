// Pins WHEN the dedupe slot is released relative to the terminal callbacks
// (so a retry from onError/onSettled is real work, not a join onto the dead
// dispatch), what a joiner of an aborted queued primary is told, and what the
// notification/rollback fault handlers report.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));
import { defineAction, _resetForTest as resetDefine } from "./define.js";
import { symbolId } from "./define-helpers.js";
import { recentLog, _resetForTest as resetRegistry } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";
import { ActionError, retryNetwork } from "./error.js";
import * as notifier from "./notifier.js";
import type { Action, ActionContext } from "./types.js";

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if ("onLine" in navigator) {
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  }
});

interface Gate<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function gate<T>(): Gate<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drains the microtask queue plus one macrotask turn. */
function settleTurn(): Promise<void> {
  return new Promise<void>((r) => {
    setTimeout(r, 0);
  });
}

function retryButton(callIndex: number): (() => void) | undefined {
  return vi.mocked(notifier.notifyError).mock.calls[callIndex]?.[1]?.onClick;
}

describe("dispatch instance identity", () => {
  it("numbers each dispatch above the one before it", async () => {
    const ids: string[] = [];
    const action = defineAction<void, string>({
      name: "identity.counter",
      error: false,
      run: (_args, _signal, ctx?: ActionContext) => {
        ids.push(ctx?.instanceID ?? "");
        return Promise.resolve("ok");
      },
    });

    await action.dispatch();
    await action.dispatch();

    expect(ids).toHaveLength(2);
    const seq = ids.map((id) => Number(id.split("#")[1]));
    expect(seq[0]).toBeGreaterThan(0);
    expect(seq[1]).toBe((seq[0] ?? 0) + 1);
  });

  it("generates an idempotency key of a base36 timestamp plus a 14-character random suffix", async () => {
    const keys: string[] = [];
    const action = defineAction<void, string>({
      name: "identity.idempotency",
      idempotencyKey: true,
      error: false,
      run: (_args, _signal, ctx?: ActionContext) => {
        keys.push(ctx?.idempotencyKey ?? "");
        return Promise.resolve("ok");
      },
    });

    await action.dispatch();

    expect(keys[0]).toMatch(/^[0-9a-z]+-[0-9a-z]{14}$/);
  });
});

describe("the dedupe slot is released before the terminal callbacks fire", () => {
  it("lets a retry dispatched from onError run instead of joining the failed dispatch", async () => {
    const runs: number[] = [];
    let retried = false;
    const action: Action<{ id: string }, string> = defineAction<{ id: string }, string>({
      name: "dedupe.release_on_error",
      dedupe: true,
      error: false,
      onError: (_err, args) => {
        if (!retried) {
          retried = true;
          void action.dispatch(args);
        }
      },
      run: () => {
        runs.push(runs.length + 1);
        return runs.length === 1
          ? Promise.reject(new ActionError("boom"))
          : Promise.resolve("recovered");
      },
    });

    await expect(action.dispatch({ id: "a" })).resolves.toBeNull();

    await vi.waitFor(() => {
      expect(runs).toHaveLength(2);
    });
  });

  it("does not evict a newer slot for the same key when the older dispatch's promise settles", async () => {
    const runs: number[] = [];
    let retried = false;
    const second = gate<string>();
    const action: Action<{ id: string }, string> = defineAction<{ id: string }, string>({
      name: "dedupe.newer_slot_survives",
      dedupe: true,
      error: false,
      onError: (_err, args) => {
        if (!retried) {
          retried = true;
          void action.dispatch(args);
        }
      },
      run: () => {
        runs.push(runs.length + 1);
        return runs.length === 1 ? Promise.reject(new ActionError("boom")) : second.promise;
      },
    });

    // onError starts a replacement dispatch; the first dispatch's own dedupe
    // cleanup must leave the replacement's slot alone.
    await action.dispatch({ id: "a" });
    await settleTurn();
    expect(runs).toHaveLength(2);

    const joiner = action.dispatch({ id: "a" });
    second.resolve("recovered");

    await expect(joiner.outcome).resolves.toEqual({ status: "success", value: "recovered" });
    expect(runs).toHaveLength(2);
  });

  it("lets a dispatch made from onSettled after a late cancellation start its own run", async () => {
    const runs: ((v: string) => void)[] = [];
    let again = false;
    const action: Action<void, string> = defineAction<void, string>({
      name: "dedupe.release_on_late_cancel",
      dedupe: true,
      error: false,
      onSettled: () => {
        if (!again) {
          again = true;
          void action.dispatch();
        }
      },
      run: () =>
        new Promise<string>((resolve) => {
          runs.push(resolve);
        }),
    });

    const first = action.dispatch();
    await vi.waitFor(() => {
      expect(runs).toHaveLength(1);
    });
    first.abort();
    runs[0]?.("late"); // completes anyway, after the abort

    await expect(first).resolves.toBeNull();
    await vi.waitFor(() => {
      expect(runs).toHaveLength(2);
    });
    runs[1]?.("second");
  });
});

describe("a scope-queued dispatch aborted before it starts", () => {
  it("tells a joiner it was cancelled, not that the dedupe failed", async () => {
    const blocked = gate<string>();
    const joinerOnError = vi.fn();
    const action = defineAction<{ k: number }, string>({
      name: "queued.abort_joiner",
      scope: "lane",
      dedupe: true,
      error: false,
      run: (args) => (args.k === 0 ? blocked.promise : Promise.resolve("ran")),
    });

    const blocker = action.dispatch({ k: 0 });
    const queued = action.dispatch({ k: 1 });
    const joiner = action.dispatch({ k: 1 }, { onError: joinerOnError });
    queued.abort();
    blocked.resolve("blocker done");
    await blocker;

    await expect(queued.outcome).resolves.toEqual({ status: "cancelled" });
    await expect(joiner.outcome).resolves.toEqual({ status: "cancelled" });
    expect(joinerOnError).not.toHaveBeenCalled();
  });

  it("frees its dedupe key before its settled hook, so a dispatch from that hook runs", async () => {
    const blocked = gate<string>();
    const runs: number[] = [];
    let again = false;
    const action: Action<{ k: number }, string> = defineAction<{ k: number }, string>({
      name: "queued.abort_releases_key",
      scope: "lane",
      dedupe: true,
      error: false,
      onSettled: (args) => {
        if (args.k === 1 && !again) {
          again = true;
          void action.dispatch({ k: 1 });
        }
      },
      run: (args) => {
        runs.push(args.k);
        return args.k === 0 ? blocked.promise : Promise.resolve("ran");
      },
    });

    const blocker = action.dispatch({ k: 0 });
    const queued = action.dispatch({ k: 1 });
    queued.abort();
    blocked.resolve("blocker done");
    await blocker;
    await expect(queued).resolves.toBeNull();

    await vi.waitFor(() => {
      expect(runs).toEqual([0, 1]);
    });
  });

  it("frees its dedupe key when optimistic() throws, so a retry from onError runs", async () => {
    const blocked = gate<string>();
    const runs: number[] = [];
    let snapshots = 0;
    let retried = false;
    const action: Action<{ k: number }, string> = defineAction<{ k: number }, string, string>({
      name: "queued.optimistic_releases_key",
      scope: "lane",
      dedupe: true,
      error: false,
      optimistic: (args) => {
        if (args.k === 1) {
          snapshots += 1;
          if (snapshots === 1) {
            throw new ActionError("snapshot failed");
          }
        }
        return "snap";
      },
      onError: (_err, args) => {
        if (args.k === 1 && !retried) {
          retried = true;
          void action.dispatch({ k: 1 });
        }
      },
      run: (args) => {
        runs.push(args.k);
        return args.k === 0 ? blocked.promise : Promise.resolve("ran");
      },
    });

    const blocker = action.dispatch({ k: 0 });
    const failing = action.dispatch({ k: 1 });
    blocked.resolve("blocker done");
    await blocker;

    await expect(failing.outcome).resolves.toMatchObject({ status: "error" });
    await vi.waitFor(() => {
      expect(runs).toEqual([0, 1]);
    });
  });
});

describe("a dispatch that fails in optimistic() before its dedupe slot is published", () => {
  it("runs a duplicate dispatched in the same tick instead of joining the dead dispatch", async () => {
    let snapshots = 0;
    const action = defineAction<{ id: string }, string, string>({
      name: "optimistic.same_tick_duplicate",
      dedupe: true,
      error: false,
      optimistic: () => {
        snapshots += 1;
        throw new ActionError("snapshot failed", { code: "quota_exceeded" });
      },
      run: () => Promise.resolve("unreachable"),
    });

    const first = action.dispatch({ id: "a" });
    const duplicate = action.dispatch({ id: "a" });

    const failure = {
      status: "error",
      error: { message: "snapshot failed", code: "quota_exceeded" },
    };
    await expect(first.outcome).resolves.toEqual(failure);
    // Same failure, reached by its own work: the first had already settled,
    // so there was no in-flight dispatch to join.
    await expect(duplicate.outcome).resolves.toEqual(failure);
    expect(snapshots).toBe(2);
    expect(recentLog().filter((e) => e.name === "optimistic.same_tick_duplicate")).toHaveLength(2);
  });

  it("does not hand its failure to a duplicate that would have succeeded", async () => {
    const runs: string[] = [];
    let snapshots = 0;
    const action = defineAction<{ id: string }, string, string>({
      name: "optimistic.duplicate_does_its_own_work",
      dedupe: true,
      error: false,
      optimistic: () => {
        snapshots += 1;
        if (snapshots === 1) {
          throw new ActionError("snapshot failed");
        }
        return "snap";
      },
      run: () => {
        runs.push("ran");
        return Promise.resolve("ok");
      },
    });

    const first = action.dispatch({ id: "a" });
    const duplicate = action.dispatch({ id: "a" });

    await expect(first.outcome).resolves.toMatchObject({ status: "error" });
    await expect(duplicate.outcome).resolves.toEqual({
      status: "success",
      value: "ok",
      attempts: 1,
    });
    expect(runs).toEqual(["ran"]);
  });

  it("releases that dedupe key once its promise settles, so the next dispatch runs", async () => {
    const runs: number[] = [];
    let snapshots = 0;
    const action = defineAction<{ id: string }, string, string>({
      name: "optimistic.slot_cleanup",
      dedupe: true,
      error: false,
      optimistic: () => {
        snapshots += 1;
        if (snapshots === 1) {
          throw new ActionError("snapshot failed");
        }
        return "snap";
      },
      run: () => {
        runs.push(1);
        return Promise.resolve("ran");
      },
    });

    await expect(action.dispatch({ id: "a" }).outcome).resolves.toMatchObject({ status: "error" });
    await settleTurn();

    await expect(action.dispatch({ id: "a" }).outcome).resolves.toEqual({
      status: "success",
      value: "ran",
      attempts: 1,
    });
    expect(runs).toHaveLength(1);
  });

  it("runs the same-tick duplicate even after cancel() finds nothing in flight", async () => {
    let snapshots = 0;
    const action = defineAction<{ id: string }, string, string>({
      name: "optimistic.idle_cancel",
      dedupe: true,
      error: false,
      optimistic: () => {
        snapshots += 1;
        throw new ActionError("snapshot failed");
      },
      run: () => Promise.resolve("unreachable"),
    });

    action.dispatch({ id: "a" });
    // The optimistic failure settled synchronously and published no dedupe
    // slot, so cancel() has nothing to change here.
    action.cancel();
    const duplicate = action.dispatch({ id: "a" });

    await expect(duplicate.outcome).resolves.toMatchObject({
      status: "error",
      error: { message: "snapshot failed" },
    });
    expect(snapshots).toBe(2);
  });
});

describe("cancel() and the scope lane", () => {
  it("records a queued dispatch as cancelled at cancel time", async () => {
    const blocked = gate<string>();
    const action = defineAction<{ k: number }, string>({
      name: "queued.cancel_record",
      scope: "lane",
      error: false,
      run: (args, signal) => {
        if (args.k !== 0) {
          return Promise.resolve("ran");
        }
        signal.addEventListener("abort", () => {
          blocked.reject(new DOMException("aborted", "AbortError"));
        });
        return blocked.promise;
      },
    });

    const blocker = action.dispatch({ k: 0 });
    const queued = action.dispatch({ k: 1 });
    action.cancel();

    await expect(queued).resolves.toBeNull();
    await blocker;
    const entry = recentLog().find((e) => (e.args as { k: number }).k === 1);
    expect(entry?.status).toBe("cancelled");
  });

  it("does not re-record a completed dispatch when called from its own onSettled", async () => {
    const settledCalls: number[] = [];
    let cancelled = false;
    const action = defineAction<{ k: number }, string>({
      name: "queued.settled_cancel",
      scope: "lane",
      error: false,
      run: () => Promise.resolve("ran"),
    });

    await action.dispatch(
      { k: 1 },
      {
        onSettled: () => {
          settledCalls.push(1);
          if (!cancelled) {
            cancelled = true;
            action.cancel();
          }
        },
      },
    );
    await settleTurn();

    expect(settledCalls).toHaveLength(1);
    const entries = recentLog().filter((e) => e.name === "queued.settled_cancel");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("success");
  });
});

describe("an aborted dispatch schedules no further retry", () => {
  it("computes no backoff delay when run() rejects after the abort", async () => {
    const delay = vi.fn(() => 5);
    const runs: number[] = [];
    const action = defineAction<void, string>({
      name: "retry.abort_no_backoff",
      retry: { count: 3, delay },
      retryable: () => true,
      error: false,
      run: (_args, signal) =>
        new Promise<string>((_resolve, reject) => {
          runs.push(1);
          signal.addEventListener("abort", () => {
            reject(new ActionError("network down", { code: "network" }));
          });
        }),
    });

    const handle = action.dispatch();
    await vi.waitFor(() => {
      expect(runs).toHaveLength(1);
    });
    handle.abort();

    await expect(handle).resolves.toBeNull();
    await expect(handle.outcome).resolves.toEqual({ status: "cancelled" });
    expect(delay).not.toHaveBeenCalled();
    expect(runs).toHaveLength(1);
  });

  it("computes no backoff delay when the cancel lands during the offline pause", async () => {
    const delay = vi.fn(() => 5);
    let attempts = 0;
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const action = defineAction<void, string>({
      name: "retry.offline_cancel_no_backoff",
      retry: { count: 5, delay },
      retryable: retryNetwork,
      error: false,
      run: () => {
        attempts += 1;
        throw new ActionError("offline", { code: "network" });
      },
    });

    const dispatched = action.dispatch();
    await new Promise((r) => setTimeout(r, 20)); // parked inside the offline wait
    expect(attempts).toBe(1);
    action.cancel();

    await expect(dispatched).resolves.toBeNull();
    expect(delay).not.toHaveBeenCalled();
    expect(attempts).toBe(1);
  });
});

describe("a faulty user callback is reported, never swallowed silently", () => {
  it("logs a success-message formatter that throws and still completes the dispatch", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const action = defineAction<void, string>({
      name: "toast.success_throws",
      success: () => {
        throw new Error("formatter broken");
      },
      run: () => Promise.resolve("ok"),
    });

    await expect(action.dispatch()).resolves.toBe("ok");

    expect(vi.mocked(notifier.notifySuccess)).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      "[actions] emitSuccessToast for toast.success_throws threw",
      expect.any(Error),
    );
    expect(recentLog()[0]?.status).toBe("success");
    logged.mockRestore();
  });

  it("logs an error-message formatter that throws and falls back to the default text", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const action = defineAction<void, string>({
      name: "chat.purge",
      error: () => {
        throw new Error("formatter broken");
      },
      run: () => Promise.reject(new ActionError("server said no")),
    });

    await action.dispatch();

    expect(logged).toHaveBeenCalledWith(
      "[actions] emitErrorToast for chat.purge threw",
      expect.any(Error),
    );
    expect(vi.mocked(notifier.notifyError)).toHaveBeenCalledWith(
      "Purge failed: server said no",
      undefined,
    );
    logged.mockRestore();
  });

  it("logs a rollback that throws while undoing a cancellation", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const late = gate<string>();
    const action = defineAction<void, string, string>({
      name: "cancel.rollback_throws",
      error: false,
      optimistic: () => "snap",
      rollback: () => {
        throw new Error("rollback broken");
      },
      run: () => late.promise,
    });

    const handle = action.dispatch();
    handle.abort();
    late.resolve("late");

    await expect(handle).resolves.toBeNull();
    expect(logged).toHaveBeenCalledWith(
      "[actions] rollback (cancellation) for cancel.rollback_throws threw",
      expect.any(Error),
    );
    expect(recentLog()[0]?.status).toBe("cancelled");
    logged.mockRestore();
  });
});

describe("the retry button's args when structuredClone cannot copy them", () => {
  it("re-dispatches null args unchanged in a runtime without structuredClone", async () => {
    vi.stubGlobal("structuredClone", undefined);
    const seen: unknown[] = [];
    const action = defineAction<null, string>({
      name: "retrybutton.null_args",
      retryable: retryNetwork,
      run: (args) => {
        seen.push(args);
        return Promise.reject(new ActionError("offline", { status: 0 }));
      },
    });

    await action.dispatch(null);

    const retry = retryButton(0);
    expect(retry).toBeDefined();
    retry?.();
    await vi.waitFor(() => {
      expect(seen).toHaveLength(2);
    });
    expect(seen[1]).toBeNull();
  });

  it("re-dispatches the original args object when the shallow copy also throws", async () => {
    const seen: unknown[] = [];
    const hostile: { token: string } = {
      get token(): string {
        throw new Error("unreadable");
      },
    };
    const action = defineAction<{ token: string }, string>({
      name: "retrybutton.unreadable_args",
      retryable: retryNetwork,
      run: (args) => {
        seen.push(args);
        return Promise.reject(new ActionError("offline", { status: 0 }));
      },
    });

    await action.dispatch(hostile);

    const retry = retryButton(0);
    expect(retry).toBeDefined();
    retry?.();
    await vi.waitFor(() => {
      expect(seen).toHaveLength(2);
    });
    expect(seen[1]).toBe(hostile);
  });
});

describe("_resetForTest", () => {
  it("restarts the symbol-identity counter so symbol dedupe keys are deterministic", () => {
    const first = Symbol("same description");
    expect(symbolId(first)).toBe(1);

    resetDefine();

    const second = Symbol("same description");
    expect(symbolId(second)).toBe(1);
  });
});
