// cleanup.test.ts drives the sweep through the _cancelAllForTest() back door,
// which never proves the listener is installed on window. These tests
// dispatch a real beforeunload event instead.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetActionFramework } from "./test-helpers/action-test-setup.js";
vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));
import { defineAction } from "./define.js";
import {
  registerCleanup,
  _cancelAllForTest as cancelAllPending,
  _resetForTest as resetCleanup,
} from "./cleanup.js";

beforeEach(() => {
  resetActionFramework();
  vi.clearAllMocks();
});

/** An action that records its abort and hangs until released. */
function abortRecordingAction(name: string) {
  const state = { aborted: false };
  let release!: () => void;
  const action = defineAction({
    name,
    run: (_args: unknown, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => {
          state.aborted = true;
          resolve();
        });
      }),
  });
  return {
    action,
    state,
    release: (): void => {
      release();
    },
  };
}

describe("cleanup — beforeunload installation", () => {
  it("runs registered hooks when the page actually unloads", () => {
    const hook = vi.fn();
    registerCleanup(hook);
    window.dispatchEvent(new Event("beforeunload"));
    expect(hook).toHaveBeenCalledOnce();
  });

  it("cancels a tracked action when the page actually unloads", async () => {
    const tracked = abortRecordingAction("test.unload.action");
    const p = tracked.action.dispatch({});
    window.dispatchEvent(new Event("beforeunload"));
    await p;
    expect(tracked.state.aborted).toBe(true);
  });

  it("re-installs the listener after a reset", () => {
    const hook = vi.fn();
    registerCleanup(hook);
    resetCleanup();

    const afterReset = vi.fn();
    registerCleanup(afterReset);
    window.dispatchEvent(new Event("beforeunload"));
    expect(afterReset).toHaveBeenCalledOnce();
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("cleanup — reset clears the tracked actions", () => {
  it("does not cancel an action that was untracked by a reset", async () => {
    const tracked = abortRecordingAction("test.reset.action");
    const p = tracked.action.dispatch({});

    resetCleanup();
    cancelAllPending();
    expect(tracked.state.aborted).toBe(false);

    tracked.release();
    await p;
  });
});
