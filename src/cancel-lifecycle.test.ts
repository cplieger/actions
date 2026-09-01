// The scope-queued paths have two competing settle sites (cancel()'s
// early-cancel resolver and runOnce's own aborted branch); a lost guard
// there shows up as a double onSettled.
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));
import { defineAction, _resetForTest as resetDefine } from "./define.js";
import { getActionLog, _resetForTest as resetRegistry } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";
import type { ActionInstance } from "./types.js";

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
  vi.clearAllMocks();
});

/** The terminal (non-pending) registry entry for an action name. */
function terminalEntry(name: string): ActionInstance | undefined {
  return getActionLog().find((e) => e.name === name && e.status !== "pending");
}

/** Let every pending microtask and macrotask callback run. */
async function settleQueues(): Promise<void> {
  await new Promise<void>((r) => {
    setTimeout(r, 0);
  });
}

describe("cancel() of a scope-queued dispatch", () => {
  it("settles the queued dispatch at cancel time, not when the lane drains", async () => {
    let releaseOccupant!: () => void;
    const gate = new Promise<void>((r) => {
      releaseOccupant = r;
    });
    const occupant = defineAction<void, string>({
      name: "cancel.lane_occupant",
      scope: "lane-a",
      run: async () => {
        await gate;
        return "occupant";
      },
    });
    const victim = defineAction<void, string>({
      name: "cancel.lane_victim",
      scope: "lane-a",
      error: false,
      run: async () => "victim",
    });

    const pOccupant = occupant.dispatch();
    await Promise.resolve();
    const pVictim = victim.dispatch();
    await Promise.resolve();
    victim.cancel();

    const raced = await Promise.race([
      pVictim.then(() => "settled"),
      new Promise<string>((r) => {
        setTimeout(() => {
          r("still-pending");
        }, 20);
      }),
    ]);
    expect(raced).toBe("settled");

    releaseOccupant();
    await pOccupant;
  });

  it("fires the settled hooks exactly once even though the lane still runs it", async () => {
    const defSettled = vi.fn();
    const optSettled = vi.fn();
    let releaseOccupant!: () => void;
    const gate = new Promise<void>((r) => {
      releaseOccupant = r;
    });
    const occupant = defineAction<void, string>({
      name: "cancel.lane_occupant_hooks",
      scope: "lane-b",
      run: async () => {
        await gate;
        return "occupant";
      },
    });
    const victim = defineAction<void, string>({
      name: "cancel.lane_victim_hooks",
      scope: "lane-b",
      error: false,
      onSettled: defSettled,
      run: async () => "victim",
    });

    const pOccupant = occupant.dispatch();
    await Promise.resolve();
    const pVictim = victim.dispatch(undefined, { onSettled: optSettled });
    await Promise.resolve();
    victim.cancel();
    releaseOccupant();
    await pOccupant;
    await pVictim;
    await settleQueues();

    expect(defSettled).toHaveBeenCalledTimes(1);
    expect(optSettled).toHaveBeenCalledTimes(1);
  });
});

describe("handle.abort() of a scope-queued dispatch", () => {
  it("records it as cancelled and never applies the optimistic update", async () => {
    let ran = false;
    const optimistic = vi.fn(() => "snapshot");
    const rollback = vi.fn();
    let releaseOccupant!: () => void;
    const gate = new Promise<void>((r) => {
      releaseOccupant = r;
    });
    const occupant = defineAction<void, string>({
      name: "abort.lane_occupant",
      scope: "lane-c",
      run: async () => {
        await gate;
        return "occupant";
      },
    });
    const victim = defineAction<void, string, string>({
      name: "abort.lane_victim",
      scope: "lane-c",
      error: false,
      optimistic,
      rollback,
      run: async () => {
        ran = true;
        return "victim";
      },
    });

    const pOccupant = occupant.dispatch();
    await Promise.resolve();
    const h = victim.dispatch();
    await Promise.resolve();
    h.abort();
    releaseOccupant();
    await pOccupant;
    await h;
    await settleQueues();

    expect(ran).toBe(false);
    expect(optimistic).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    expect(terminalEntry("abort.lane_victim")?.status).toBe("cancelled");
  });

  it("fires the settled hooks exactly once", async () => {
    const defSettled = vi.fn();
    const optSettled = vi.fn();
    let releaseOccupant!: () => void;
    const gate = new Promise<void>((r) => {
      releaseOccupant = r;
    });
    const occupant = defineAction<void, string>({
      name: "abort.lane_occupant_hooks",
      scope: "lane-d",
      run: async () => {
        await gate;
        return "occupant";
      },
    });
    const victim = defineAction<void, string>({
      name: "abort.lane_victim_hooks",
      scope: "lane-d",
      error: false,
      onSettled: defSettled,
      run: async () => "victim",
    });

    const pOccupant = occupant.dispatch();
    await Promise.resolve();
    const h = victim.dispatch(undefined, { onSettled: optSettled });
    await Promise.resolve();
    h.abort();
    releaseOccupant();
    await pOccupant;
    await h;
    await settleQueues();

    expect(defSettled).toHaveBeenCalledTimes(1);
    expect(optSettled).toHaveBeenCalledTimes(1);
  });
});

describe("cancel() of a running scoped dispatch", () => {
  it("fires the settled hooks exactly once", async () => {
    const defSettled = vi.fn();
    const optSettled = vi.fn();
    const action = defineAction<void, string>({
      name: "cancel.running_scoped",
      scope: "lane-e",
      error: false,
      onSettled: defSettled,
      run: (_args, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });

    const h = action.dispatch(undefined, { onSettled: optSettled });
    await Promise.resolve();
    await Promise.resolve();
    action.cancel();
    await h;
    await settleQueues();

    expect(defSettled).toHaveBeenCalledTimes(1);
    expect(optSettled).toHaveBeenCalledTimes(1);
  });
});

describe("cancel arriving after the run already resolved", () => {
  it("rolls back with a cancelled error and settles once", async () => {
    const rollback = vi.fn();
    const defSettled = vi.fn();
    let release!: (v: string) => void;
    const gate = new Promise<string>((r) => {
      release = r;
    });
    const action = defineAction<{ id: string }, string, string>({
      name: "cancel.after_run_resolved",
      error: false,
      optimistic: () => "snapshot",
      rollback,
      onSettled: defSettled,
      // Deliberately signal-blind: the work completes even though the
      // dispatch was cancelled while it was in flight.
      run: async () => gate,
    });

    const h = action.dispatch({ id: "a" });
    await Promise.resolve();
    h.abort();
    release("late");
    await h;
    await settleQueues();

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledWith({ id: "a" }, "snapshot", {
      message: "cancelled",
      code: "cancelled",
    });
    expect(defSettled).toHaveBeenCalledTimes(1);
    expect(terminalEntry("cancel.after_run_resolved")?.status).toBe("cancelled");
  });
});
