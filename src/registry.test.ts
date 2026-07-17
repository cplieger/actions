// @vitest-environment happy-dom
// Targeted tests for registry.ts: bounded settled retention, in-flight
// protection, Set-based listener iteration, pendingCount/recentLog
// correctness, the transition-table edges, the leak watchdog, _resetForTest.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  record,
  subscribe,
  recentLog,
  getActionLog,
  pendingCount,
  isPending,
  _resetForTest,
} from "./registry.js";
import type { ActionInstance } from "./types.js";

function makeInstance(overrides: Partial<ActionInstance> = {}): ActionInstance {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    name: "test.action",
    status: "pending",
    args: {},
    dispatchedAt: Date.now(),
    startedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  _resetForTest();
});

describe("bounded eviction", () => {
  it("evicts oldest non-pending entry when log exceeds MAX_LOG_SIZE (200)", () => {
    for (let i = 0; i < 200; i++) {
      record(makeInstance({ id: `a-${i}`, status: "success" }));
    }
    expect(recentLog()).toHaveLength(200);
    record(makeInstance({ id: "overflow", status: "success" }));
    expect(recentLog()).toHaveLength(200);
  });

  it("preserves pending entries during soft eviction", () => {
    for (let i = 0; i < 200; i++) {
      record(makeInstance({ id: `p-${i}`, status: "pending" }));
    }
    record(makeInstance({ id: "extra", status: "pending" }));
    expect(recentLog()).toHaveLength(201);
    expect(pendingCount()).toBe(201);
  });

  it("in-flight watchdog (1000) force-evicts pending entries and decrements pendingCount", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 1000; i++) {
      record(makeInstance({ id: `h-${i}`, status: "pending" }));
    }
    expect(pendingCount()).toBe(1000);
    record(makeInstance({ id: "hard-overflow", status: "pending" }));
    expect(pendingCount()).toBe(1000);
    expect(recentLog()).toHaveLength(1000);
    consoleSpy.mockRestore();
  });

  it("heavy settled churn keeps the log bounded with no gaps", () => {
    for (let i = 0; i < 260; i++) {
      record(makeInstance({ id: `c-${i}`, status: "success" }));
    }
    for (let i = 0; i < 260; i++) {
      record(makeInstance({ id: `d-${i}`, status: "success" }));
    }
    const log = recentLog();
    expect(log.length).toBeLessThanOrEqual(200);
    for (const entry of log) {
      expect(entry).not.toBeNull();
    }
  });
});

describe("listener iteration", () => {
  it("listener can unsubscribe itself during notification", () => {
    const calls: string[] = [];
    const unsub = subscribe(() => {
      calls.push("self");
      unsub();
    });
    subscribe(() => calls.push("other"));
    record(makeInstance());
    expect(calls).toContain("self");
    expect(calls).toContain("other");
    calls.length = 0;
    record(makeInstance());
    expect(calls).toEqual(["other"]);
  });

  it("listener that unsubscribes a later listener prevents it from firing", () => {
    const calls: string[] = [];
    // eslint-disable-next-line prefer-const
    let unsubB: (() => void) | undefined;
    subscribe(() => {
      calls.push("A");
      unsubB?.();
    });
    unsubB = subscribe(() => {
      calls.push("B");
    });
    record(makeInstance());
    expect(calls).toEqual(["A"]);
  });

  it("listener added during iteration fires for the current event", () => {
    const calls: string[] = [];
    subscribe(() => {
      calls.push("first");
      subscribe(() => calls.push("dynamic"));
    });
    record(makeInstance());
    expect(calls).toContain("first");
    expect(calls).toContain("dynamic");
  });

  it("throwing listener does not prevent other listeners from firing", () => {
    const calls: string[] = [];

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    subscribe(() => {
      throw new Error("boom");
    });
    subscribe(() => calls.push("survived"));
    record(makeInstance());
    expect(calls).toEqual(["survived"]);
    expect(consoleSpy).toHaveBeenCalledWith("[actions] registry listener threw", expect.any(Error));
    consoleSpy.mockRestore();
  });
});

describe("recentLog", () => {
  it("never returns null entries", () => {
    for (let i = 0; i < 250; i++) {
      record(makeInstance({ id: `r-${i}`, status: "success" }));
    }
    const log = recentLog();
    for (const entry of log) {
      expect(entry).not.toBeNull();
      expect(entry).not.toBeUndefined();
    }
  });

  it("returns entries in insertion order", () => {
    record(makeInstance({ id: "first", status: "success" }));
    record(makeInstance({ id: "second", status: "success" }));
    record(makeInstance({ id: "third", status: "success" }));
    const log = recentLog();
    expect(log.map((e) => e.id)).toEqual(["first", "second", "third"]);
  });
});

describe("getActionLog snapshot isolation", () => {
  it("returns a snapshot — mutating the returned array does not affect the internal log", () => {
    record(makeInstance({ id: "snap-1", status: "success" }));
    record(makeInstance({ id: "snap-2", status: "success" }));
    const snapshot = getActionLog();
    expect(snapshot).toHaveLength(2);
    // A caller mutating the returned array must not corrupt internal state.
    (snapshot as unknown[]).length = 0;
    expect(getActionLog()).toHaveLength(2);
  });
});

describe("_resetForTest", () => {
  it("clears all state including pendingCount and listeners", () => {
    const listener = vi.fn();
    subscribe(listener);
    record(makeInstance({ id: "pre", status: "pending" }));
    expect(pendingCount()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    _resetForTest();
    listener.mockClear();
    expect(recentLog()).toHaveLength(0);
    expect(pendingCount()).toBe(0);
    expect(pendingCount(["test.action"])).toBe(0);
    record(makeInstance({ id: "post", status: "pending" }));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("pendingN tracking", () => {
  it("increments on new pending, decrements on transition to success", () => {
    record(makeInstance({ id: "t1", status: "pending" }));
    expect(pendingCount()).toBe(1);
    record(makeInstance({ id: "t1", status: "success", completedAt: Date.now() }));
    expect(pendingCount()).toBe(0);
  });

  it("handles pending -> error transition", () => {
    record(makeInstance({ id: "t2", status: "pending" }));
    expect(pendingCount()).toBe(1);
    record(makeInstance({ id: "t2", status: "error", error: { message: "fail" } }));
    expect(pendingCount()).toBe(0);
  });

  it("handles pending -> cancelled transition", () => {
    record(makeInstance({ id: "t3", status: "pending" }));
    record(makeInstance({ id: "t3", status: "cancelled" }));
    expect(pendingCount()).toBe(0);
  });

  it("does not double-decrement on repeated terminal transitions", () => {
    record(makeInstance({ id: "t4", status: "pending" }));
    record(makeInstance({ id: "t4", status: "success" }));
    record(makeInstance({ id: "t4", status: "success" }));
    expect(pendingCount()).toBe(0);
  });

  it("handles non-pending to pending transition (unusual but valid)", () => {
    record(makeInstance({ id: "t5", status: "success" }));
    expect(pendingCount()).toBe(0);
    record(makeInstance({ id: "t5", status: "pending" }));
    expect(pendingCount()).toBe(1);
  });
});

describe("pendingByName index", () => {
  it("isPending returns true for pending action, false after completion", () => {
    record(makeInstance({ id: "p1", name: "chat.send", status: "pending" }));
    expect(isPending("chat.send")).toBe(true);
    record(makeInstance({ id: "p1", name: "chat.send", status: "success" }));
    expect(isPending("chat.send")).toBe(false);
  });

  it("isPending returns false for unknown action name", () => {
    expect(isPending("nonexistent")).toBe(false);
  });

  it("tracks multiple pending instances of the same name", () => {
    record(makeInstance({ id: "a1", name: "file.upload", status: "pending" }));
    record(makeInstance({ id: "a2", name: "file.upload", status: "pending" }));
    expect(isPending("file.upload")).toBe(true);
    expect(pendingCount(["file.upload"])).toBe(2);
    record(makeInstance({ id: "a1", name: "file.upload", status: "success" }));
    expect(isPending("file.upload")).toBe(true);
    expect(pendingCount(["file.upload"])).toBe(1);
    record(
      makeInstance({ id: "a2", name: "file.upload", status: "error", error: { message: "fail" } }),
    );
    expect(isPending("file.upload")).toBe(false);
    expect(pendingCount(["file.upload"])).toBe(0);
  });

  it("retry (terminal→pending) re-adds to pendingByName", () => {
    record(makeInstance({ id: "r1", name: "git.push", status: "pending" }));
    record(
      makeInstance({ id: "r1", name: "git.push", status: "error", error: { message: "timeout" } }),
    );
    expect(isPending("git.push")).toBe(false);
    record(makeInstance({ id: "r1", name: "git.push", status: "pending" }));
    expect(isPending("git.push")).toBe(true);
    expect(pendingCount(["git.push"])).toBe(1);
  });

  it("pending→pending re-record does not duplicate in index", () => {
    record(makeInstance({ id: "d1", name: "chat.send", status: "pending" }));
    record(makeInstance({ id: "d1", name: "chat.send", status: "pending" }));
    expect(pendingCount(["chat.send"])).toBe(1);
    expect(pendingCount()).toBe(1);
  });

  it("watchdog eviction removes from pendingByName", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 1000; i++) {
      record(makeInstance({ id: `hc-${i}`, name: "bulk.op", status: "pending" }));
    }
    expect(isPending("bulk.op")).toBe(true);
    record(makeInstance({ id: "hc-overflow", name: "bulk.op", status: "pending" }));
    expect(pendingCount()).toBe(1000);
    const pending = recentLog().filter((i) => i.status === "pending" && i.name === "bulk.op");
    expect(pending.find((e) => e.id === "hc-0")).toBeUndefined();
    consoleSpy.mockRestore();
  });

  it("_resetForTest clears pendingByName", () => {
    record(makeInstance({ id: "z1", name: "action.a", status: "pending" }));
    record(makeInstance({ id: "z2", name: "action.b", status: "pending" }));
    expect(isPending("action.a")).toBe(true);
    expect(isPending("action.b")).toBe(true);
    _resetForTest();
    expect(isPending("action.a")).toBe(false);
    expect(isPending("action.b")).toBe(false);
  });
});

// The _pendingTotal invariant-clamp tests were deleted with the clamp: the
// pending total is now `inflight.size` (membership), so the negative-total
// state those tests exercised is unrepresentable.

describe("split-shape transition table", () => {
  it("retains the newest 200 terminals, evicting first-record order first", () => {
    for (let i = 0; i < 250; i++) {
      record(makeInstance({ id: `t-${String(i)}`, status: "success" }));
    }
    const log = recentLog();
    expect(log).toHaveLength(200);
    expect(log[0]?.id).toBe("t-50");
    expect(log[199]?.id).toBe("t-249");
  });

  it("a long-lived pending survives hundreds of settled records and still settles", () => {
    record(makeInstance({ id: "long", name: "slow.op", status: "pending" }));
    for (let i = 0; i < 300; i++) {
      record(makeInstance({ id: `churn-${String(i)}`, status: "success" }));
    }
    expect(isPending("slow.op")).toBe(true);
    const stillThere = recentLog().find((e) => e.id === "long");
    expect(stillThere?.status).toBe("pending");
    // First-record order: the oldest entry in the view is the pending one.
    expect(recentLog()[0]?.id).toBe("long");

    record(makeInstance({ id: "long", name: "slow.op", status: "success" }));
    expect(isPending("slow.op")).toBe(false);
    expect(pendingCount()).toBe(0);
    const settledNow = recentLog().find((e) => e.id === "long");
    expect(settledNow?.status).toBe("success");
  });

  it("pending re-record overwrites in place without double-counting", () => {
    record(makeInstance({ id: "rr", name: "x.y", status: "pending" }));
    record(makeInstance({ id: "rr", name: "x.y", status: "pending", attempts: 2 }));
    expect(pendingCount()).toBe(1);
    const entries = recentLog().filter((e) => e.id === "rr");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.attempts).toBe(2);
  });

  it("double-terminal record keeps one latest-per-id entry", () => {
    record(makeInstance({ id: "dt", status: "error" }));
    record(makeInstance({ id: "dt", status: "cancelled" }));
    const entries = recentLog().filter((e) => e.id === "dt");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("cancelled");
    expect(pendingCount()).toBe(0);
  });

  it("terminal-only record (no prior pending) lands in the log", () => {
    record(makeInstance({ id: "term-only", status: "cancelled" }));
    expect(recentLog().find((e) => e.id === "term-only")?.status).toBe("cancelled");
    expect(pendingCount()).toBe(0);
  });

  it("terminal → pending re-record moves the entry back and re-indexes it", () => {
    record(makeInstance({ id: "revive", name: "z.op", status: "pending" }));
    record(makeInstance({ id: "revive", name: "z.op", status: "error" }));
    expect(isPending("z.op")).toBe(false);
    // Not produced by define.ts; the transition table defines it anyway.
    record(makeInstance({ id: "revive", name: "z.op", status: "pending" }));
    expect(isPending("z.op")).toBe(true);
    expect(pendingCount()).toBe(1);
    const entries = recentLog().filter((e) => e.id === "revive");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("pending");
  });

  it("keeps first-record order across interleaved pending and terminal records", () => {
    record(makeInstance({ id: "o-1", name: "a", status: "pending" }));
    record(makeInstance({ id: "o-2", name: "b", status: "success" }));
    record(makeInstance({ id: "o-3", name: "c", status: "pending" }));
    // o-1 settles AFTER o-3 was first recorded; its view position must not move.
    record(makeInstance({ id: "o-1", name: "a", status: "success" }));
    expect(recentLog().map((e) => e.id)).toEqual(["o-1", "o-2", "o-3"]);
  });
});

describe("in-flight leak watchdog", () => {
  it("reclaims the oldest pending past the threshold with a warn and corrected counts", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i <= 1000; i++) {
      record(makeInstance({ id: `leak-${String(i)}`, name: "leaky.op", status: "pending" }));
    }
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy.mock.calls[0]?.[0]).toContain("leaky.op");
    expect(consoleSpy.mock.calls[0]?.[0]).toContain("leak-0");
    expect(pendingCount()).toBe(1000);
    expect(isPending("leaky.op")).toBe(true);
    expect(recentLog().find((e) => e.id === "leak-0")).toBeUndefined();
    consoleSpy.mockRestore();
  });
});
