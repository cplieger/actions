// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));
import { defineAction, _resetForTest as resetDefine } from "./define.js";
import { _resetForTest as resetRegistry, recentLog } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";
import { ActionError, retryNetwork } from "./error.js";

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
  vi.clearAllMocks();
});

describe("two retry-configured actions in the same scope", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("second action waits for first action's retries to complete before starting", async () => {
    let attemptA = 0;
    let attemptB = 0;
    const actionA = defineAction<void, string>({
      name: "test.scope_retry_A",
      scope: "shared",
      retryable: retryNetwork,
      retry: { count: 2, delay: 100 },
      error: false,
      run: () => {
        attemptA++;
        if (attemptA < 3) {
          throw new ActionError("net", { code: "network" });
        }
        return Promise.resolve("A-done");
      },
    });
    const actionB = defineAction<void, string>({
      name: "test.scope_retry_B",
      scope: "shared",
      retryable: retryNetwork,
      retry: { count: 1, delay: 50 },
      error: false,
      run: () => {
        attemptB++;
        return Promise.resolve("B-done");
      },
    });
    const pA = actionA.dispatch();
    await Promise.resolve();
    const pB = actionB.dispatch();
    await Promise.resolve();
    expect(attemptA).toBe(1);
    expect(attemptB).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(attemptA).toBe(2);
    expect(attemptB).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    const rA = await pA;
    expect(rA).toBe("A-done");
    await Promise.resolve();
    const rB = await pB;
    expect(rB).toBe("B-done");
    expect(attemptB).toBe(1);
  });
});

describe("onSuccess → dispatch chain with same scope", () => {
  it("chained dispatch via onSuccess runs after the triggering action completes", async () => {
    const order: string[] = [];
    const actionA = defineAction<void, string>({
      name: "test.chain_A",
      scope: "chain",
      run: () => {
        order.push("A-run");
        return Promise.resolve("A-result");
      },
    });
    const actionB = defineAction<void, string>({
      name: "test.chain_B",
      scope: "chain",
      run: () => {
        order.push("B-run");
        return Promise.resolve("B-result");
      },
    });
    let chainedPromise: Promise<string | null> | null = null;
    const pA = actionA.dispatch(undefined, {
      onSuccess: () => {
        order.push("A-onSuccess");
        chainedPromise = actionB.dispatch();
      },
    });
    const rA = await pA;
    expect(rA).toBe("A-result");
    const rB = await chainedPromise!;
    expect(rB).toBe("B-result");
    expect(order).toEqual(["A-run", "A-onSuccess", "B-run"]);
  });
});

describe("cancellation during retry unblocks queued action", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancelling a retrying action lets the queued action proceed", async () => {
    let attemptA = 0;
    let attemptB = 0;
    const actionA = defineAction<void, string>({
      name: "test.cancel_retry_A",
      scope: "cancel-scope",
      retryable: (err) => err.code !== "cancelled",
      retry: { count: 5, delay: 100 },
      error: false,
      run: () => {
        attemptA++;
        throw new ActionError("fail", { status: 500 });
      },
    });
    const actionB = defineAction<void, string>({
      name: "test.cancel_retry_B",
      scope: "cancel-scope",
      error: false,
      run: () => {
        attemptB++;
        return Promise.resolve("B-done");
      },
    });
    const pA = actionA.dispatch();
    await Promise.resolve();
    const pB = actionB.dispatch();
    await Promise.resolve();
    expect(attemptA).toBe(1);
    expect(attemptB).toBe(0);
    actionA.cancel();
    const rA = await pA;
    expect(rA).toBeNull();
    await Promise.resolve();
    const rB = await pB;
    expect(rB).toBe("B-done");
    expect(attemptB).toBe(1);
  });
});

describe("throwing callbacks don't break scope chain", () => {
  it("onSuccess throwing does not re-record action as error", async () => {
    const action = defineAction<void, string>({
      name: "test.cb_throw_success",
      scope: "cb-scope",
      run: () => Promise.resolve("ok"),
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await action.dispatch(undefined, {
      onSuccess: () => {
        throw new Error("callback boom");
      },
    });
    consoleSpy.mockRestore();
    expect(result).toBe("ok");
    const log = recentLog();
    const entry = log.find((e) => e.name === "test.cb_throw_success");
    expect(entry?.status).toBe("success");
  });
});
