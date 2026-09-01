// Covers two edges the rest of the suite doesn't: the self-dispose latch
// (re-attach before the deferred dispose runs) and the nothing-holds-focus
// arm of the focus-restore guard.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetActionFramework } from "./test-helpers/action-test-setup.js";
vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));
import { bindLoadingState } from "./loading.js";
import { record } from "./registry.js";
import type { ActionInstance } from "./types.js";

function instance(id: string, name: string, status: ActionInstance["status"]): ActionInstance {
  return {
    id,
    name,
    status,
    args: {},
    dispatchedAt: Date.now(),
    startedAt: Date.now(),
  };
}

beforeEach(() => {
  resetActionFramework();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

afterEach(() => {
  // Undoes the forced activeElement override some tests below install.
  Reflect.deleteProperty(document as unknown as Record<string, unknown>, "activeElement");
  vi.restoreAllMocks();
});

describe("bindLoadingState — the self-dispose latch", () => {
  it("leaves an element alone once it has left the document, even if it returns before the deferred dispose runs", () => {
    const btn = document.createElement("button");
    document.body.append(btn);
    bindLoadingState("load.detach", btn);

    btn.remove();

    // Effect notices the detach and latches disposed, deferring unsubscribe to a microtask.
    record(instance("detach-1", "load.detach", "pending"));
    expect(btn.disabled).toBe(false);

    // Still the same turn (dispose hasn't run); re-attaching must not resurrect the binding.
    document.body.append(btn);
    record(instance("detach-2", "load.detach", "pending"));

    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute("aria-busy")).toBeNull();
  });

  it("still binds normally for an element that stays in the document", () => {
    const btn = document.createElement("button");
    document.body.append(btn);
    bindLoadingState("load.attached", btn);

    record(instance("attached-1", "load.attached", "pending"));
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");

    record(instance("attached-1", "load.attached", "success"));
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute("aria-busy")).toBeNull();
  });
});

describe("bindLoadingState — focus restore when nothing holds focus", () => {
  it("returns focus to the element when activeElement is null", () => {
    const btn = document.createElement("button");
    document.body.append(btn);
    const focusSpy = vi.spyOn(btn, "focus");
    bindLoadingState("load.focus_null", btn);

    btn.focus();
    record(instance("focus-1", "load.focus_null", "pending"));
    expect(btn.disabled).toBe(true);

    // Chromium parks activeElement on <body>, never null, on disable; this guard
    // arm defends a non-browser engine and is only reachable by forcing it here.
    Object.defineProperty(document, "activeElement", { value: null, configurable: true });
    focusSpy.mockClear();

    record(instance("focus-1", "load.focus_null", "success"));

    expect(btn.disabled).toBe(false);
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it("latches itself disposed before restoring, so an update triggered by the restore cannot re-disable the element", () => {
    const btn = document.createElement("button");
    document.body.append(btn);
    const unbind = bindLoadingState("load.reentrant", btn);

    btn.focus();
    record(instance("re-1", "load.reentrant", "pending"));
    expect(btn.disabled).toBe(true);

    // The restore hands focus back to the button; re-dispatching from that
    // focus handler makes the disposer's own restore reentrant.
    let reentrantRecords = 0;
    btn.addEventListener(
      "focus",
      () => {
        reentrantRecords += 1;
        record(instance("re-2", "load.reentrant", "pending"));
      },
      { once: true },
    );
    // focus() on the already-focused element fires nothing; park elsewhere first.
    const sink = document.createElement("input");
    document.body.append(sink);
    sink.focus();
    sink.remove();
    Object.defineProperty(document, "activeElement", { value: null, configurable: true });

    unbind();

    expect(reentrantRecords).toBe(1);
    // Binding was released before the restore ran; the reentrant record must not reach the element.
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute("aria-busy")).toBeNull();
  });

  it("does not take focus back from a competing element", () => {
    const btn = document.createElement("button");
    const other = document.createElement("input");
    document.body.append(btn, other);
    const focusSpy = vi.spyOn(btn, "focus");
    bindLoadingState("load.focus_moved", btn);

    btn.focus();
    record(instance("moved-1", "load.focus_moved", "pending"));

    other.focus();
    focusSpy.mockClear();

    record(instance("moved-1", "load.focus_moved", "success"));

    expect(focusSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(other);
  });
});
