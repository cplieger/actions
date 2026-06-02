// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetActionFramework } from "./__test-helpers__/action-test-setup.js";
vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));
import { defineAction } from "./define.js";
import { bindLoadingState } from "./loading.js";

beforeEach(() => {
  resetActionFramework();
  vi.clearAllMocks();
});

describe("bindLoadingState — single name", () => {
  it("toggles disabled while action is pending", async () => {
    let resolveRun: (value: string) => void;
    const action = defineAction({
      name: "test.bind1",
      run: () =>
        new Promise<string>((r) => {
          resolveRun = r;
        }),
    });
    const btn = document.createElement("button");
    bindLoadingState("test.bind1", btn);
    expect(btn.disabled).toBe(false);
    const p = action.dispatch({});
    expect(btn.disabled).toBe(true);
    resolveRun!("ok");
    await p;
    expect(btn.disabled).toBe(false);
  });

  it("sets aria-busy by default + clears on completion", async () => {
    let resolveRun: () => void;
    const action = defineAction({
      name: "test.bind2",
      run: () =>
        new Promise<void>((r) => {
          resolveRun = r;
        }),
    });
    const btn = document.createElement("button");
    bindLoadingState("test.bind2", btn);
    const p = action.dispatch({});
    expect(btn.getAttribute("aria-busy")).toBe("true");
    resolveRun!();
    await p;
    expect(btn.getAttribute("aria-busy")).toBeNull();
  });

  it("pendingClass adds + removes a CSS class", async () => {
    let resolveRun: () => void;
    const action = defineAction({
      name: "test.bind4",
      run: () =>
        new Promise<void>((r) => {
          resolveRun = r;
        }),
    });
    const btn = document.createElement("button");
    bindLoadingState("test.bind4", btn, { pendingClass: "btn-loading" });
    const p = action.dispatch({});
    expect(btn.classList.contains("btn-loading")).toBe(true);
    resolveRun!();
    await p;
    expect(btn.classList.contains("btn-loading")).toBe(false);
  });

  it("multiple in-flight instances keep btn disabled until ALL complete", async () => {
    const resolvers: (() => void)[] = [];
    const action = defineAction({
      name: "test.bind7",
      run: () =>
        new Promise<void>((r) => {
          resolvers.push(r);
        }),
    });
    const btn = document.createElement("button");
    bindLoadingState("test.bind7", btn);
    const p1 = action.dispatch({});
    const p2 = action.dispatch({});
    expect(btn.disabled).toBe(true);
    resolvers[0]!();
    await p1;
    expect(btn.disabled).toBe(true);
    resolvers[1]!();
    await p2;
    expect(btn.disabled).toBe(false);
  });

  it("returns an unsubscribe that stops further updates", async () => {
    let resolveRun: () => void;
    const action = defineAction({
      name: "test.bind8",
      run: () =>
        new Promise<void>((r) => {
          resolveRun = r;
        }),
    });
    const btn = document.createElement("button");
    const unbind = bindLoadingState("test.bind8", btn);
    unbind();
    const p = action.dispatch({});
    expect(btn.disabled).toBe(false);
    resolveRun!();
    await p;
  });
});

describe("bindLoadingState — multi-name", () => {
  it("disables while ANY named action is pending", async () => {
    let resolve1!: () => void;
    let resolve2!: () => void;
    const a1 = defineAction({
      name: "test.multi1",
      run: () =>
        new Promise<void>((r) => {
          resolve1 = r;
        }),
    });
    const a2 = defineAction({
      name: "test.multi2",
      run: () =>
        new Promise<void>((r) => {
          resolve2 = r;
        }),
    });
    const btn = document.createElement("button");
    bindLoadingState(["test.multi1", "test.multi2"], btn);
    expect(btn.disabled).toBe(false);
    const p1 = a1.dispatch({});
    expect(btn.disabled).toBe(true);
    const p2 = a2.dispatch({});
    resolve1();
    await p1;
    expect(btn.disabled).toBe(true);
    resolve2();
    await p2;
    expect(btn.disabled).toBe(false);
  });
});
