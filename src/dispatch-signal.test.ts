import { describe, it, expect, vi, beforeEach } from "vitest";
import { defineAction } from "./define.js";
import { configure } from "./notifier.js";
import { getActionLog } from "./registry.js";
import { resetActionFramework } from "./test-helpers/action-test-setup.js";
import type { ActionOutcome } from "./types.js";

beforeEach(() => {
  resetActionFramework();
  configure({});
});

/** Resolves `"pending"` when `p` has not settled after every queued task ran. */
async function settledOrPending<T>(p: Promise<T>): Promise<T | "pending"> {
  return Promise.race([
    p,
    new Promise<"pending">((r) => {
      setTimeout(() => {
        r("pending");
      }, 0);
    }),
  ]);
}

async function drain(): Promise<void> {
  await new Promise<void>((r) => {
    setTimeout(r, 0);
  });
}

function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
}

function blockingOccupant(scope: string, until: Promise<void>) {
  return defineAction<void, string>({
    name: `occupant.${scope}`,
    scope,
    run: async () => {
      await until;
      return "occupant";
    },
  });
}

function statusesOf(name: string): string[] {
  return getActionLog()
    .filter((e) => e.name === name)
    .map((e) => e.status);
}

const CANCELLED: ActionOutcome<string> = { status: "cancelled" };

describe("DispatchOptions.signal on a dispatch queued behind its scope", () => {
  it("settles cancelled at once and never calls run", async () => {
    const lane = gate();
    const run = vi.fn(async () => "victim");
    const onSettled = vi.fn();
    const occupant = blockingOccupant("lane-a", lane.wait);
    const victim = defineAction<void, string>({ name: "victim.lane_a", scope: "lane-a", run });
    const ac = new AbortController();

    const pOccupant = occupant.dispatch();
    const h = victim.dispatch(undefined, { signal: ac.signal, onSettled });
    ac.abort();

    expect(await settledOrPending(h.outcome)).toEqual(CANCELLED);
    expect(await h).toBeNull();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(statusesOf("victim.lane_a")).toEqual(["cancelled"]);

    lane.open();
    await pOccupant;
    await drain();
    expect(run).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("keeps the scope's order for the dispatches behind it", async () => {
    const lane = gate();
    const order: string[] = [];
    const occupant = blockingOccupant("lane-b", lane.wait);
    const later = defineAction<string, string>({
      name: "later.lane_b",
      scope: "lane-b",
      run: async (tag) => {
        order.push(tag);
        return tag;
      },
    });
    const ac = new AbortController();

    const pOccupant = occupant.dispatch();
    const victim = later.dispatch("victim", { signal: ac.signal });
    const after = later.dispatch("after");
    ac.abort();
    await victim;

    expect(await settledOrPending(after)).toBe("pending");
    lane.open();
    await pOccupant;
    expect(await after).toBe("after");
    expect(order).toEqual(["after"]);
  });

  it("settles at once when the signal was aborted before the dispatch", async () => {
    const lane = gate();
    const run = vi.fn(async () => "victim");
    const optimistic = vi.fn();
    const occupant = blockingOccupant("lane-c", lane.wait);
    const victim = defineAction<void, string>({
      name: "victim.lane_c",
      scope: "lane-c",
      optimistic,
      run,
    });

    const pOccupant = occupant.dispatch();
    const h = victim.dispatch(undefined, { signal: AbortSignal.abort() });

    expect(await settledOrPending(h.outcome)).toEqual(CANCELLED);
    lane.open();
    await pOccupant;
    await drain();
    expect(run).not.toHaveBeenCalled();
    expect(optimistic).not.toHaveBeenCalled();
  });
});

describe("DispatchOptions.signal on an unscoped dispatch", () => {
  it("never calls run or optimistic when already aborted", async () => {
    const run = vi.fn(async () => "never");
    const optimistic = vi.fn();
    const onSettled = vi.fn();
    const defSettled = vi.fn();
    const action = defineAction<void, string>({
      name: "pre_aborted",
      optimistic,
      onSettled: defSettled,
      run,
    });

    const h = action.dispatch(undefined, { signal: AbortSignal.abort(), onSettled });

    expect(await h.outcome).toEqual(CANCELLED);
    expect(run).not.toHaveBeenCalled();
    expect(optimistic).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(defSettled).toHaveBeenCalledTimes(1);
    expect(statusesOf("pre_aborted")).toEqual(["cancelled"]);
  });

  it("aborts run's signal with the signal's reason mid-run and settles cancelled", async () => {
    let seen: unknown;
    const rollback = vi.fn();
    const action = defineAction<void, string, string>({
      name: "mid_run",
      optimistic: () => "snapshot",
      rollback,
      run: (_args, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            seen = signal.reason;
            reject(signal.reason as Error);
          });
        }),
    });
    const ac = new AbortController();
    const reason = new DOMException("view closed", "AbortError");

    const h = action.dispatch(undefined, { signal: ac.signal });
    expect(await settledOrPending(h.outcome)).toBe("pending");
    ac.abort(reason);

    expect(await h.outcome).toEqual(CANCELLED);
    expect(seen).toBe(reason);
    expect(rollback).toHaveBeenCalledWith(undefined, "snapshot", {
      message: "cancelled",
      code: "cancelled",
    });
    expect(statusesOf("mid_run")).toEqual(["cancelled"]);
  });

  it("discards a result that arrives after the abort", async () => {
    const work = gate();
    const onSuccess = vi.fn();
    const action = defineAction<void, string>({
      name: "signal_blind",
      run: async () => {
        await work.wait;
        return "late";
      },
    });
    const ac = new AbortController();

    const h = action.dispatch(undefined, { signal: ac.signal, onSuccess });
    ac.abort();
    work.open();

    expect(await h.outcome).toEqual(CANCELLED);
    expect(await h).toBeNull();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("stops a retry waiting out its backoff", async () => {
    const run = vi.fn(() => Promise.reject(new Error("flaky")));
    const action = defineAction<void, string>({
      name: "retrying",
      error: false,
      networkMode: "always",
      retryable: () => true,
      retry: { count: 3, delay: 10_000 },
      run,
    });
    const ac = new AbortController();

    const h = action.dispatch(undefined, { signal: ac.signal });
    await settledOrPending(h.outcome);
    ac.abort();

    expect(await h.outcome).toEqual(CANCELLED);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("removes its abort listener once the dispatch settles", async () => {
    const ac = new AbortController();
    const added = vi.spyOn(ac.signal, "addEventListener");
    const removed = vi.spyOn(ac.signal, "removeEventListener");
    const action = defineAction<void, string>({ name: "listener_cleanup", run: async () => "ok" });

    expect(await action.dispatch(undefined, { signal: ac.signal })).toBe("ok");
    await drain();

    expect(added).toHaveBeenCalledTimes(1);
    const listener = added.mock.calls[0]?.[1];
    expect(removed).toHaveBeenCalledWith("abort", listener);
  });
});

describe("handle.abort() on a dispatch queued behind its scope", () => {
  it("settles cancelled at once rather than when the lane drains", async () => {
    const lane = gate();
    const occupant = blockingOccupant("lane-d", lane.wait);
    const victim = defineAction<void, string>({
      name: "victim.lane_d",
      scope: "lane-d",
      run: async () => "victim",
    });

    const pOccupant = occupant.dispatch();
    const h = victim.dispatch();
    h.abort();

    expect(await settledOrPending(h.outcome)).toEqual(CANCELLED);
    lane.open();
    await pOccupant;
  });
});

describe("a dedupe joiner's cancellation", () => {
  function joinable(run: () => Promise<string>) {
    return defineAction<void, string>({ name: "joinable", dedupe: true, run });
  }

  it("settles only the joiner when its signal aborts; the leader keeps running", async () => {
    const work = gate();
    const run = vi.fn(async () => {
      await work.wait;
      return "shared";
    });
    const action = joinable(run);
    const joinerSuccess = vi.fn();
    const joinerSettled = vi.fn();
    const ac = new AbortController();

    const leader = action.dispatch();
    const joiner = action.dispatch(undefined, {
      signal: ac.signal,
      onSuccess: joinerSuccess,
      onSettled: joinerSettled,
    });
    ac.abort();

    expect(await settledOrPending(joiner.outcome)).toEqual(CANCELLED);
    expect(await joiner).toBeNull();
    work.open();
    expect(await leader.outcome).toMatchObject({ status: "success", value: "shared" });
    await drain();
    expect(run).toHaveBeenCalledTimes(1);
    expect(joinerSuccess).not.toHaveBeenCalled();
    expect(joinerSettled).toHaveBeenCalledTimes(1);
  });

  it("settles cancelled without waiting when the joiner's signal was already aborted", async () => {
    const work = gate();
    const action = joinable(async () => {
      await work.wait;
      return "shared";
    });

    const leader = action.dispatch();
    const joiner = action.dispatch(undefined, { signal: AbortSignal.abort() });

    expect(await settledOrPending(joiner.outcome)).toEqual(CANCELLED);
    work.open();
    expect(await leader).toBe("shared");
  });

  it("settles only the joiner on handle.abort()", async () => {
    const work = gate();
    const action = joinable(async () => {
      await work.wait;
      return "shared";
    });

    const leader = action.dispatch();
    const joiner = action.dispatch();
    joiner.abort();

    expect(await settledOrPending(joiner.outcome)).toEqual(CANCELLED);
    work.open();
    expect(await leader).toBe("shared");
  });

  it("settles a cancelled joiner once when the leader's setup then throws", async () => {
    const onSettled = vi.fn();
    const action = defineAction<void, string>({
      name: "joinable.setup_throws",
      dedupe: true,
      idempotencyKey: () => {
        throw new Error("key generator failed");
      },
      run: async () => "never",
    });
    const ac = new AbortController();

    const leader = action.dispatch();
    leader.catch(() => undefined);
    const joiner = action.dispatch(undefined, { signal: ac.signal, onSettled });
    ac.abort();

    expect(await joiner.outcome).toEqual(CANCELLED);
    await expect(leader).rejects.toThrow("key generator failed");
    await drain();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("removes the joiner's abort listener when the leader settles first", async () => {
    const ac = new AbortController();
    const removed = vi.spyOn(ac.signal, "removeEventListener");
    const action = joinable(async () => "shared");

    const leader = action.dispatch();
    const joiner = action.dispatch(undefined, { signal: ac.signal });

    expect(await joiner).toBe("shared");
    expect(await leader).toBe("shared");
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    ac.abort();
    expect(await joiner.outcome).toMatchObject({ status: "success", value: "shared" });
  });
});
