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
import { ActionError, retryNetwork } from "./error.js";
import * as notifier from "./notifier.js";

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
  vi.clearAllMocks();
});

describe("dedupe with undefined args", () => {
  it("dedupe: true collapses dispatches when args is undefined", async () => {
    let runCalls = 0;
    const action = defineAction<void, string>({
      name: "test.dedupe_undefined_args",
      dedupe: true,
      run: () => {
        runCalls++;
        return new Promise<string>((r) =>
          setTimeout(() => {
            r("ok");
          }, 10),
        );
      },
    });
    const p1 = action.dispatch(undefined);
    const p2 = action.dispatch(undefined);
    expect(runCalls).toBe(1);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("ok");
    expect(r2).toBe("ok");
  });
});

describe("structuredClone fallback on retry (non-cloneable args)", () => {
  it("retry button uses shallow copy when structuredClone fails (DOM refs)", async () => {
    const el = { tagName: "BUTTON", focus: () => {} };
    let lastArgs: { el: typeof el; label: string } | undefined;
    const action = defineAction<{ el: typeof el; label: string }, string>({
      name: "test.retry_dom_args",
      run: async (args) => {
        lastArgs = args;
        throw new ActionError("fail", { status: 0 });
      },
      retryable: retryNetwork,
    });
    const args = { el, label: "Save" };
    await action.dispatch(args);
    args.label = "MUTATED";
    const retryFn = vi.mocked(notifier.notifyError).mock.calls[0]?.[1]?.onClick as () => void;
    expect(retryFn).toBeDefined();
    retryFn();
    await vi.waitFor(() => {
      expect(lastArgs).toBeDefined();
    });
    expect(lastArgs!.label).toBe("Save");
    expect(lastArgs!.el).toBe(el);
  });
});

describe("cancel after dedupe entry created but before runOnce starts (scope-queued)", () => {
  it("cancel while scope-queued resolves null without running", async () => {
    let resolveOccupant: (() => void) | null = null;
    let victimRan = false;
    const occupant = defineAction<void, string>({
      name: "test.scope_occ",
      scope: "q",
      run: () =>
        new Promise<string>((r) => {
          resolveOccupant = () => r("occ");
        }),
    });
    const victim = defineAction<void, string>({
      name: "test.scope_victim",
      scope: "q",
      dedupe: true,
      error: false,
      run: () => {
        victimRan = true;
        return Promise.resolve("v");
      },
    });
    const pOcc = occupant.dispatch();
    await Promise.resolve();
    const pVictim = victim.dispatch();
    await Promise.resolve();
    victim.cancel();
    resolveOccupant!();
    await pOcc;
    const rVictim = await pVictim;
    expect(rVictim).toBeNull();
    expect(victimRan).toBe(false);
  });
});
