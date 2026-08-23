// Two rules in registry.ts's listener plumbing that the existing suite covers
// but does not distinguish: a throwing NAME-SCOPED listener has to be reported
// (the all-listeners loop is the one already asserted), and the identity guard
// on unsubscribe exists so an unsubscribe handle that outlived its Set cannot
// detach whoever registered next under the same name.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { record, subscribe, subscribeByName, _resetForTest } from "./registry.js";
import type { ActionInstance } from "./types.js";

function instance(overrides: Partial<ActionInstance> = {}): ActionInstance {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    name: "chat.send",
    status: "success",
    args: {},
    dispatchedAt: Date.now(),
    startedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  _resetForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetForTest();
});

describe("record — a throwing listener is reported, whichever loop it sits in", () => {
  it("reports a throwing name-scoped listener and still notifies the ones after it", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const survivor = vi.fn();

    subscribeByName("chat.send", () => {
      throw new Error("named listener exploded");
    });
    subscribeByName("chat.send", survivor);

    expect(() => {
      record(instance({ id: "named-throw" }));
    }).not.toThrow();

    expect(survivor).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0]?.[0]).toBe("[actions] registry listener threw");
    expect(errorLog.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it("reports a throw from each loop separately when both a global and a named listener fail", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    subscribe(() => {
      throw new Error("global listener exploded");
    });
    subscribeByName("chat.send", () => {
      throw new Error("named listener exploded");
    });

    record(instance({ id: "both-throw" }));

    expect(errorLog).toHaveBeenCalledTimes(2);
  });
});

describe("subscribeByName — a stale unsubscribe handle cannot detach a later listener", () => {
  it("leaves a listener registered after a reset attached when the pre-reset handle is called", () => {
    const stale = vi.fn();
    const off = subscribeByName("chat.send", stale);

    // The reset drops the Set `off` closed over; anything registered afterwards
    // lives in a NEW Set under the same name.
    _resetForTest();

    const later = vi.fn();
    subscribeByName("chat.send", later);

    off();

    record(instance({ id: "stale-unsub" }));

    expect(later).toHaveBeenCalledTimes(1);
    expect(stale).not.toHaveBeenCalled();
  });

  it("still detaches only its own listener on the normal path", () => {
    const first = vi.fn();
    const second = vi.fn();
    const off = subscribeByName("chat.send", first);
    subscribeByName("chat.send", second);

    off();
    record(instance({ id: "normal-unsub" }));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
