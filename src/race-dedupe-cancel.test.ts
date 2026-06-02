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

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
  vi.clearAllMocks();
});

describe("dedupe + cancel + immediate re-dispatch race", () => {
  it("re-dispatch after cancel should start a fresh run, not collapse onto cancelled", async () => {
    let runCount = 0;
    const action = defineAction<string, string>({
      name: "test.dedupe_cancel_redispatch",
      dedupe: true,
      error: false,
      run: (_args, signal) => {
        runCount++;
        const myRun = runCount;
        return new Promise<string>((resolve, reject) => {
          if (signal.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
          setTimeout(() => {
            resolve(`result-${myRun}`);
          }, 10);
        });
      },
    });
    const p1 = action.dispatch("x");
    action.cancel();
    const p2 = action.dispatch("x");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBeNull();
    expect(r2).toBe("result-2");
    expect(runCount).toBe(2);
  });

  it("second cancel after re-dispatch still works correctly", async () => {
    let runCount = 0;
    const action = defineAction<string, string>({
      name: "test.dedupe_double_cancel",
      dedupe: true,
      error: false,
      run: (_args, signal) => {
        runCount++;
        return new Promise<string>((resolve, reject) => {
          if (signal.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
          setTimeout(() => {
            resolve(`result-${runCount}`);
          }, 10);
        });
      },
    });
    const p1 = action.dispatch("x");
    action.cancel();
    await p1;
    await Promise.resolve();
    await Promise.resolve();
    const p2 = action.dispatch("x");
    action.cancel();
    await p2;
    const p3 = action.dispatch("x");
    const r3 = await p3;
    expect(r3).toBe(`result-${runCount}`);
    expect(runCount).toBe(3);
  });
});
