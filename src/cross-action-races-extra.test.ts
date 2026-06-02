// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("./notifier.js", () => ({ configure: vi.fn(), notifySuccess: vi.fn(), notifyError: vi.fn(), _resetNotifierForTest: vi.fn() }));
import { defineAction, _resetForTest as resetDefine, _internalsForTest } from "./define.js";
import { _resetForTest as resetRegistry } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";
import { ActionError, retryNetwork } from "./error.js";

beforeEach(() => { resetDefine(); resetRegistry(); resetCleanup(); vi.clearAllMocks(); });

describe("dedupe + scope combined behavior", () => {
  it("deduped dispatch shares the scope-queued promise without double-queuing", async () => {
    let runCount = 0;
    let resolveRun: ((v: string) => void) | null = null;
    const action = defineAction<string, string>({ name: "test.dedupe_scope", dedupe: true, scope: "ds", run: () => { runCount++; return new Promise<string>((r) => { resolveRun = r; }); } });
    const p1 = action.dispatch("x");
    const p2 = action.dispatch("x");
    await Promise.resolve();
    expect(runCount).toBe(1);
    resolveRun!("done");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("done");
    expect(r2).toBe("done");
  });
});

describe("optimistic persistence across retries", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("rollback fires exactly once after all retries exhaust", async () => {
    const rollbackCalls: string[] = [];
    let attempt = 0;
    const action = defineAction<string, string, string>({ name: "test.opt_retry_rollback", retryable: (err) => err.code !== "cancelled", retry: { count: 2, delay: 50 }, error: false, optimistic: (args) => `snap-${args}`, rollback: (_args, op) => { rollbackCalls.push(op ?? "none"); }, run: () => { attempt++; throw new ActionError("fail", { status: 500 }); } });
    const p = action.dispatch("x");
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(attempt).toBe(3);
    expect(rollbackCalls).toEqual(["snap-x"]);
  });

  it("rollback does NOT fire when retries eventually succeed", async () => {
    const rollbackCalls: string[] = [];
    let attempt = 0;
    const action = defineAction<string, string, string>({ name: "test.opt_retry_success", retryable: retryNetwork, retry: { count: 2, delay: 30 }, optimistic: (args) => `snap-${args}`, rollback: (_args, op) => { rollbackCalls.push(op ?? "none"); }, run: () => { attempt++; if (attempt < 3) { throw new ActionError("net", { code: "network" }); } return Promise.resolve("recovered"); } });
    const p = action.dispatch("y");
    await vi.advanceTimersByTimeAsync(30);
    await vi.advanceTimersByTimeAsync(60);
    const result = await p;
    expect(result).toBe("recovered");
    expect(rollbackCalls).toEqual([]);
  });
});

describe("onSettled re-dispatch with dedupe", () => {
  it("dispatch from onSettled with same dedupe key starts a fresh run", async () => {
    let runCount = 0;
    const action = defineAction<string, string>({ name: "test.settled_redispatch", dedupe: true, run: () => { runCount++; return Promise.resolve(`run-${String(runCount)}`); } });
    let chainedPromise: Promise<string | null> | null = null;
    await action.dispatch("k", { onSettled: () => { chainedPromise = action.dispatch("k"); } });
    const result = await chainedPromise!;
    expect(runCount).toBe(2);
    expect(result).toBe("run-2");
  });
});

describe("scope chain after optimistic throw", () => {
  it("next action in scope runs after optimistic throw", async () => {
    const order: string[] = [];
    const broken = defineAction<void, string>({ name: "test.opt_throw", scope: "opt-throw", error: false, optimistic: () => { throw new Error("optimistic boom"); }, run: () => Promise.resolve("never") });
    const follower = defineAction<void, string>({ name: "test.opt_throw_follower", scope: "opt-throw", run: () => { order.push("follower-run"); return Promise.resolve("ok"); } });
    const pBroken = broken.dispatch();
    const pFollower = follower.dispatch();
    const rBroken = await pBroken;
    expect(rBroken).toBeNull();
    const rFollower = await pFollower;
    expect(rFollower).toBe("ok");
    expect(order).toEqual(["follower-run"]);
  });
});

describe("rapid cancel + re-dispatch", () => {
  it("re-dispatch after cancel uses a fresh AbortController", async () => {
    const signalAborted: boolean[] = [];
    const action = defineAction<void, string>({ name: "test.rapid_cancel", error: false, run: (_args, signal) => { signalAborted.push(signal.aborted); if (signal.aborted) { throw new DOMException("aborted", "AbortError"); } return Promise.resolve("ok"); } });
    const p1 = action.dispatch();
    action.cancel();
    await p1;
    const p2 = action.dispatch();
    const r2 = await p2;
    expect(r2).toBe("ok");
    expect(signalAborted[1]).toBe(false);
  });
});

describe("idempotency key stability across retries", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("same idempotency key is passed to all retry attempts", async () => {
    const keys: (string | undefined)[] = [];
    const action = defineAction<void, string>({ name: "test.idem_retry", idempotencyKey: true, retryable: (err) => err.code !== "cancelled", retry: { count: 2, delay: 20 }, error: false, run: (_args, _signal, ctx) => { keys.push(ctx?.idempotencyKey); throw new ActionError("fail", { status: 500 }); } });
    const p = action.dispatch();
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(40);
    await p;
    expect(keys.length).toBe(3);
    expect(keys[0]).toBeDefined();
    expect(keys[0]).toBe(keys[1]);
    expect(keys[1]).toBe(keys[2]);
  });

  it("different dispatches get different idempotency keys", async () => {
    const keys: (string | undefined)[] = [];
    const action = defineAction<void, string>({ name: "test.idem_unique", idempotencyKey: true, run: (_args, _signal, ctx) => { keys.push(ctx?.idempotencyKey); return Promise.resolve("ok"); } });
    await action.dispatch();
    await action.dispatch();
    expect(keys.length).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
