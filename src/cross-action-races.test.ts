// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));
import { defineAction, _resetForTest as resetDefine, _internalsForTest } from "./define.js";
import { _resetForTest as resetRegistry, recentLog } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";
import { ActionError } from "./error.js";

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
  vi.clearAllMocks();
});

describe("dedupe + retry interaction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("deduped caller's onError fires with the real error after retries exhaust", async () => {
    let attempt = 0;
    const action = defineAction<string, string>({
      name: "test.dedupe_retry",
      dedupe: true,
      retryable: (err) => err.code !== "cancelled",
      retry: { count: 2, delay: 50 },
      error: false,
      run: () => {
        attempt++;
        throw new ActionError("server down", { status: 503 });
      },
    });
    const onError1 = vi.fn();
    const onError2 = vi.fn();
    const p1 = action.dispatch("x", { onError: onError1 });
    const p2 = action.dispatch("x", { onError: onError2 });
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(100);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(attempt).toBe(3);
    expect(onError1).toHaveBeenCalledWith(
      expect.objectContaining({ message: "server down", status: 503 }),
      "x",
    );
    expect(onError2).toHaveBeenCalledWith(
      expect.objectContaining({ message: "server down", status: 503 }),
      "x",
    );
  });

  it("dedupe map is cleaned up after retry exhaustion", async () => {
    const action = defineAction<string, string>({
      name: "test.dedupe_cleanup",
      dedupe: true,
      retryable: (err) => err.code !== "cancelled",
      retry: { count: 1, delay: 20 },
      error: false,
      run: () => {
        throw new ActionError("fail", { status: 500 });
      },
    });
    const p = action.dispatch("z");
    await vi.advanceTimersByTimeAsync(20);
    await p;
    const { activeDedupes } = _internalsForTest();
    expect(activeDedupes).toBe(0);
  });
});

describe("cancel during scope-queued wait", () => {
  it("cancelling a queued action that hasn't started lets subsequent actions proceed", async () => {
    let resolveOccupant: (() => void) | null = null;
    const order: string[] = [];
    const occupant = defineAction<void, string>({
      name: "test.queue_cancel_occ",
      scope: "q-cancel",
      run: () =>
        new Promise<string>((r) => {
          resolveOccupant = () => {
            r("occ");
          };
        }),
    });
    const victim = defineAction<void, string>({
      name: "test.queue_cancel_victim",
      scope: "q-cancel",
      error: false,
      run: () => {
        order.push("victim-run");
        return Promise.resolve("victim");
      },
    });
    const follower = defineAction<void, string>({
      name: "test.queue_cancel_follower",
      scope: "q-cancel",
      run: () => {
        order.push("follower-run");
        return Promise.resolve("follower");
      },
    });
    const pOcc = occupant.dispatch();
    await Promise.resolve();
    const pVictim = victim.dispatch();
    const pFollower = follower.dispatch();
    await Promise.resolve();
    victim.cancel();
    resolveOccupant!();
    await pOcc;
    const rVictim = await pVictim;
    expect(rVictim).toBeNull();
    expect(order).not.toContain("victim-run");
    const rFollower = await pFollower;
    expect(rFollower).toBe("follower");
    expect(order).toContain("follower-run");
  });
});

describe("dedupe + cancel interaction", () => {
  it("cancelling the original dispatch propagates cancellation to deduped caller", async () => {
    const action = defineAction<string, string>({
      name: "test.dedupe_cancel",
      dedupe: true,
      error: false,
      run: (_args, signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });
    const onSettled1 = vi.fn();
    const onSettled2 = vi.fn();
    const p1 = action.dispatch("a", { onSettled: onSettled1 });
    const p2 = action.dispatch("a", { onSettled: onSettled2 });
    action.cancel();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(onSettled1).toHaveBeenCalledTimes(1);
    expect(onSettled2).toHaveBeenCalledTimes(1);
  });

  it("dedupe map is cleaned up after cancellation", async () => {
    const action = defineAction<string, string>({
      name: "test.dedupe_cancel_cleanup",
      dedupe: true,
      error: false,
      run: (_args, signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });
    const p = action.dispatch("b");
    action.cancel();
    await p;
    const { activeDedupes } = _internalsForTest();
    expect(activeDedupes).toBe(0);
  });

  it("aborting a deduped follower is a no-op — it still settles with the leader's result", async () => {
    let leaderResolve!: (v: string) => void;
    const action = defineAction<string, string>({
      name: "test.dedupe_follower_abort",
      dedupe: true,
      error: false,
      run: () =>
        new Promise<string>((r) => {
          leaderResolve = r;
        }),
    });
    const onSettled2 = vi.fn();
    const h1 = action.dispatch("a");
    const h2 = action.dispatch("a", { onSettled: onSettled2 });
    // The follower shares the leader's promise, so aborting its handle does nothing.
    h2.abort();
    leaderResolve("done");
    const r1 = await h1;
    const r2 = await h2;
    expect(r1).toBe("done");
    expect(r2).toBe("done");
    expect(onSettled2).toHaveBeenCalledTimes(1);
  });
});

describe("interleaved cross-action scope chain ordering", () => {
  it("A-B-A-B dispatches serialize in dispatch order", async () => {
    const order: string[] = [];
    const actionA = defineAction<number, string>({
      name: "test.interleave_A",
      scope: "interleave",
      run: (n) => {
        order.push(`A-${String(n)}`);
        return Promise.resolve(`A-${String(n)}`);
      },
    });
    const actionB = defineAction<number, string>({
      name: "test.interleave_B",
      scope: "interleave",
      run: (n) => {
        order.push(`B-${String(n)}`);
        return Promise.resolve(`B-${String(n)}`);
      },
    });
    const p1 = actionA.dispatch(1);
    const p2 = actionB.dispatch(1);
    const p3 = actionA.dispatch(2);
    const p4 = actionB.dispatch(2);
    await Promise.all([p1, p2, p3, p4]);
    expect(order).toEqual(["A-1", "B-1", "A-2", "B-2"]);
  });

  it("scope chain drains completely — no leaked promises", async () => {
    const action = defineAction<number, number>({
      name: "test.drain",
      scope: "drain",
      run: (n) => Promise.resolve(n),
    });
    await action.dispatch(1);
    await action.dispatch(2);
    await action.dispatch(3);
    const { scopeChains } = _internalsForTest();
    expect(scopeChains).toBe(0);
  });
});

describe("handle.abort() on a scope-queued dispatch", () => {
  it("cancels the queued dispatch without running it once the scope frees", async () => {
    const runSpy = vi.fn().mockResolvedValue("ok");
    let blockerResolve: ((v: string) => void) | undefined;
    const blocker = defineAction({
      name: "test.queued_abort_blocker",
      scope: "queued-abort",
      run: () =>
        new Promise<string>((resolve) => {
          blockerResolve = resolve;
        }),
    });
    const target = defineAction({
      name: "test.queued_abort_target",
      scope: "queued-abort",
      run: runSpy,
    });
    const h1 = blocker.dispatch("a");
    await Promise.resolve();
    await Promise.resolve();
    expect(blockerResolve).toBeDefined();
    const h2 = target.dispatch("b");
    h2.abort();
    blockerResolve!("done");
    await h1;
    const r2 = await h2;
    expect(r2).toBeNull();
    expect(runSpy).not.toHaveBeenCalled();
  });
});

describe("dedupe key namespacing", () => {
  it("two actions with the same args but different names do not share a dedupe slot", async () => {
    const action1 = defineAction({
      name: "test.dedupe_ns_1",
      dedupe: true,
      run: async () => "result1",
    });
    const action2 = defineAction({
      name: "test.dedupe_ns_2",
      dedupe: true,
      run: async () => "result2",
    });
    const [r1, r2] = await Promise.all([
      action1.dispatch("same-args"),
      action2.dispatch("same-args"),
    ]);
    expect(r1).toBe("result1");
    expect(r2).toBe("result2");
  });
});

describe("cancel during retry backoff with scope + dedupe + timeout", () => {
  it("records cancelled and leaves no dedupe slot behind", async () => {
    let attempt = 0;
    const action = defineAction({
      name: "test.cancel_backoff_combined",
      scope: "combined-scope",
      dedupe: true,
      timeout: 5000,
      retry: { count: 5, delay: 100 },
      retryable: () => true,
      run: async (_a, signal) => {
        attempt++;
        if (attempt <= 2) throw new Error("transient");
        await new Promise<never>((_r, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      },
    });
    const handle = action.dispatch("x");
    await new Promise((r) => setTimeout(r, 50));
    action.cancel();
    const result = await handle;
    expect(result).toBeNull();
    const entry = recentLog().find((e) => e.name === "test.cancel_backoff_combined");
    expect(entry?.status).toBe("cancelled");
    expect(_internalsForTest().activeDedupes).toBe(0);
  });
});

describe("scope chain release after run settles abnormally", () => {
  it("releases the scope chain after run() throws so the next dispatch proceeds", async () => {
    let callCount = 0;
    const action = defineAction({
      name: "test.scope_release_throw",
      scope: "release-throw",
      error: false,
      run: async () => {
        callCount++;
        if (callCount === 1) throw new Error("first fails");
        return "second-ok";
      },
    });
    const r1 = await action.dispatch("a");
    expect(r1).toBeNull();
    const r2 = await action.dispatch("b");
    expect(r2).toBe("second-ok");
    expect(_internalsForTest().scopeChains).toBe(0);
  });

  it("releases the scope chain after a cancel so the next dispatch proceeds", async () => {
    let resolve1!: (v: string) => void;
    const action = defineAction<string, string>({
      name: "test.scope_release_cancel",
      scope: "release-cancel",
      error: false,
      run: (args) => {
        if (args === "first") {
          return new Promise<string>((r) => {
            resolve1 = r;
          });
        }
        return Promise.resolve("second-ok");
      },
    });
    const h1 = action.dispatch("first");
    await Promise.resolve();
    h1.abort();
    resolve1("ignored");
    await h1;
    const r2 = await action.dispatch("second");
    expect(r2).toBe("second-ok");
    expect(_internalsForTest().scopeChains).toBe(0);
  });
});
