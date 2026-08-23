// The two halves of cleanup.ts nothing else pins: the fault isolation inside
// cancelAllPending (a throwing participant must be REPORTED, not just
// swallowed — a silent catch is how a cancel that never runs goes unnoticed),
// and the beforeunload listener's install-once / remove-on-reset bookkeeping.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { registerCleanup, _registerAction, _cancelAllForTest, _resetForTest } from "./cleanup.js";
import type { Action } from "./types.js";

/** Minimal tracked-action stand-in: cleanup only ever reads `name` + `cancel`. */
function cancellable(name: string, cancel: () => void): Action<unknown, unknown> {
  return { name, cancel } as unknown as Action<unknown, unknown>;
}

beforeEach(() => {
  _resetForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetForTest();
});

describe("cancelAllPending — a throwing participant is reported and does not stop the rest", () => {
  it("names the action whose cancel() threw and still cancels the others", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const survivor = vi.fn();

    _registerAction(
      cancellable("boom.op", () => {
        throw new Error("cancel exploded");
      }),
    );
    _registerAction(cancellable("calm.op", survivor));

    expect(() => {
      _cancelAllForTest();
    }).not.toThrow();

    expect(survivor).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0]?.[0]).toBe("[actions] cancel for boom.op threw");
    expect(errorLog.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it("reports a throwing cleanup hook and still runs the hooks after it", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const survivor = vi.fn();

    registerCleanup(() => {
      throw new Error("hook exploded");
    });
    registerCleanup(survivor);

    expect(() => {
      _cancelAllForTest();
    }).not.toThrow();

    expect(survivor).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0]?.[0]).toBe("[actions] cleanup hook threw");
    expect(errorLog.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });
});

describe("cleanup — the beforeunload listener's install-once bookkeeping", () => {
  it("attaches exactly one beforeunload listener however many hooks and actions register", () => {
    const add = vi.spyOn(window, "addEventListener");

    registerCleanup(() => undefined);
    registerCleanup(() => undefined);
    _registerAction(cancellable("tracked.op", () => undefined));

    const beforeunloadAttachments = add.mock.calls.filter(([type]) => type === "beforeunload");
    expect(beforeunloadAttachments).toHaveLength(1);
  });

  it("detaches the beforeunload listener on reset, using the callback it attached", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");

    registerCleanup(() => undefined);
    const attached = add.mock.calls.find(([type]) => type === "beforeunload")?.[1];
    expect(typeof attached).toBe("function");
    expect(remove.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(0);

    _resetForTest();

    const detachments = remove.mock.calls.filter(([type]) => type === "beforeunload");
    expect(detachments).toHaveLength(1);
    expect(detachments[0]?.[1]).toBe(attached);
  });

  it("re-attaches after a reset, so a fresh registration is still wired to unload", () => {
    _resetForTest();
    const add = vi.spyOn(window, "addEventListener");

    registerCleanup(() => undefined);
    expect(add.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(1);

    _resetForTest();
    registerCleanup(() => undefined);
    expect(add.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(2);
  });
});
