// Every element here is IN the document (unlike loading.test.ts), which is
// what the connection tracking and focus guard key on.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetActionFramework } from "./test-helpers/action-test-setup.js";
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
  document.body.replaceChildren();
});

/** An action whose run() hangs until `settle()` is called. */
function controllable(name: string) {
  let resolveRun!: () => void;
  const action = defineAction({
    name,
    run: () =>
      new Promise<void>((r) => {
        resolveRun = r;
      }),
  });
  return {
    action,
    settle: (): void => {
      resolveRun();
    },
  };
}

function attachedButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  document.body.appendChild(btn);
  return btn;
}

/** Parks focus on <body> so a test whose premise is "never had focus" starts
 * clean — Browser Mode shares one page per FILE, not per test. */
function parkFocusOnBody(): void {
  const sink = document.createElement("button");
  document.body.appendChild(sink);
  sink.focus();
  sink.blur();
  sink.remove();
}

describe("bindLoadingState — binding and unbinding an idle element", () => {
  it("does not touch a pre-disabled element when it binds", () => {
    controllable("load.bind_idle");
    const btn = attachedButton();
    btn.disabled = true;
    bindLoadingState("load.bind_idle", btn);
    expect(btn.disabled).toBe(true);
  });

  it("does not touch a pre-disabled element when it unbinds without ever going pending", () => {
    controllable("load.unbind_idle");
    const btn = attachedButton();
    btn.disabled = true;
    const unbind = bindLoadingState("load.unbind_idle", btn);
    unbind();
    expect(btn.disabled).toBe(true);
  });

  it("re-enables a pre-disabled element after a pending cycle by default", async () => {
    const { action, settle } = controllable("load.reenable");
    const btn = attachedButton();
    btn.disabled = true;
    bindLoadingState("load.reenable", btn);
    const p = action.dispatch({});
    settle();
    await p;
    expect(btn.disabled).toBe(false);
  });
});

describe("bindLoadingState — elements in the document", () => {
  it("toggles disabled on an element that is in the document", async () => {
    const { action, settle } = controllable("load.attached");
    const btn = attachedButton();
    bindLoadingState("load.attached", btn);
    const p = action.dispatch({});
    expect(btn.disabled).toBe(true);
    settle();
    await p;
    expect(btn.disabled).toBe(false);
  });

  it("does not disable an element that left the document after binding", async () => {
    const { action, settle } = controllable("load.detached");
    const btn = attachedButton();
    bindLoadingState("load.detached", btn);
    btn.remove();
    const p = action.dispatch({});
    expect(btn.disabled).toBe(false);
    settle();
    await p;
    expect(btn.disabled).toBe(false);
  });

  it("tracks an element attached after binding, then stops once it is removed", async () => {
    const { action, settle } = controllable("load.late_attach");
    const btn = document.createElement("button");
    bindLoadingState("load.late_attach", btn);
    document.body.appendChild(btn);

    const first = action.dispatch({});
    expect(btn.disabled).toBe(true);
    settle();
    await first;
    expect(btn.disabled).toBe(false);

    btn.remove();
    const second = action.dispatch({});
    expect(btn.disabled).toBe(false);
    settle();
    await second;
  });
});

describe("bindLoadingState — aria-busy management", () => {
  it("ariaBusy: false never writes aria-busy", async () => {
    const { action, settle } = controllable("load.no_aria");
    const btn = attachedButton();
    bindLoadingState("load.no_aria", btn, { ariaBusy: false });
    const p = action.dispatch({});
    expect(btn.getAttribute("aria-busy")).toBeNull();
    settle();
    await p;
    expect(btn.getAttribute("aria-busy")).toBeNull();
  });

  it("preserveAriaBusy leaves a caller-owned aria-busy attribute in place", async () => {
    const { action, settle } = controllable("load.keep_aria");
    const btn = attachedButton();
    btn.setAttribute("aria-busy", "true");
    bindLoadingState("load.keep_aria", btn, { preserveAriaBusy: true });
    const p = action.dispatch({});
    settle();
    await p;
    expect(btn.getAttribute("aria-busy")).toBe("true");
  });
});

describe("bindLoadingState — preserveDisabled", () => {
  it("restores the element's own disabled state instead of enabling it", async () => {
    const { action, settle } = controllable("load.preserve");
    const btn = attachedButton();
    bindLoadingState("load.preserve", btn, { preserveDisabled: true });
    btn.disabled = true;
    const p = action.dispatch({});
    expect(btn.disabled).toBe(true);
    settle();
    await p;
    expect(btn.disabled).toBe(true);
  });

  it("does not mistake its own pending disable for the element's base state", async () => {
    const a1 = controllable("load.preserve_multi_1");
    const a2 = controllable("load.preserve_multi_2");
    const btn = attachedButton();
    bindLoadingState(["load.preserve_multi_1", "load.preserve_multi_2"], btn, {
      preserveDisabled: true,
    });

    const p1 = a1.action.dispatch({});
    const p2 = a2.action.dispatch({});
    expect(btn.disabled).toBe(true);

    a1.settle();
    await p1;
    a2.settle();
    await p2;
    expect(btn.disabled).toBe(false);
  });
});

describe("bindLoadingState — disabledFn", () => {
  it("asks disabledFn for the idle disabled state on every transition", async () => {
    const { action, settle } = controllable("load.disabled_fn");
    const btn = attachedButton();
    let locked = true;
    bindLoadingState("load.disabled_fn", btn, { disabledFn: () => locked });

    const first = action.dispatch({});
    settle();
    await first;
    expect(btn.disabled).toBe(true);

    locked = false;
    const second = action.dispatch({});
    settle();
    await second;
    expect(btn.disabled).toBe(false);
  });

  it("falls back to enabling the element when disabledFn throws", async () => {
    const { action, settle } = controllable("load.disabled_fn_throws");
    const btn = attachedButton();
    bindLoadingState("load.disabled_fn_throws", btn, {
      preserveDisabled: true,
      disabledFn: () => {
        throw new Error("boom");
      },
    });
    btn.disabled = true;
    const p = action.dispatch({});
    settle();
    await p;
    expect(btn.disabled).toBe(false);
  });
});

describe("bindLoadingState — focus restoration", () => {
  it("returns focus to the element when focus fell to the body while pending", async () => {
    const { action, settle } = controllable("load.focus_back");
    const btn = attachedButton();
    btn.focus();
    bindLoadingState("load.focus_back", btn);
    const p = action.dispatch({});
    // Browser drops focus to <body> on disable by itself; not simulated here.
    expect(document.activeElement).toBe(document.body);
    settle();
    await p;
    expect(document.activeElement).toBe(btn);
  });

  it("does not take focus back from an element the user moved to", async () => {
    const { action, settle } = controllable("load.focus_moved");
    const btn = attachedButton();
    const other = document.createElement("input");
    document.body.appendChild(other);
    btn.focus();
    bindLoadingState("load.focus_moved", btn);
    const p = action.dispatch({});
    other.focus();
    settle();
    await p;
    expect(document.activeElement).toBe(other);
  });

  it("does not focus an element that never had focus", async () => {
    const { action, settle } = controllable("load.focus_never");
    const btn = attachedButton();
    parkFocusOnBody();
    bindLoadingState("load.focus_never", btn);
    const p = action.dispatch({});
    settle();
    await p;
    expect(document.activeElement).toBe(document.body);
  });

  it("does not focus an element that left the document while pending", async () => {
    const { action, settle } = controllable("load.focus_detached");
    const btn = attachedButton();
    btn.focus();
    const unbind = bindLoadingState("load.focus_detached", btn);
    const p = action.dispatch({});
    btn.remove();
    unbind();
    expect(document.activeElement).toBe(document.body);
    settle();
    await p;
  });
});

describe("bindLoadingState — the disposer", () => {
  it("releases a pending element when unbound mid-flight", async () => {
    const { action, settle } = controllable("load.unbind_pending");
    const btn = attachedButton();
    const unbind = bindLoadingState("load.unbind_pending", btn, { pendingClass: "busy" });
    const p = action.dispatch({});
    expect(btn.disabled).toBe(true);

    unbind();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute("aria-busy")).toBeNull();
    expect(btn.classList.contains("busy")).toBe(false);

    settle();
    await p;
  });

  it("is inert when called a second time", async () => {
    const { action, settle } = controllable("load.unbind_twice");
    const btn = attachedButton();
    const unbind = bindLoadingState("load.unbind_twice", btn);
    const p = action.dispatch({});

    unbind();
    expect(btn.disabled).toBe(false);

    btn.disabled = true;
    unbind();
    expect(btn.disabled).toBe(true);

    settle();
    await p;
  });
});
