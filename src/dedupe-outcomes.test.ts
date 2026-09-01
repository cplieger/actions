// A joiner must inherit the primary's cancellation, not the "deduped dispatch
// did not succeed" fallback, on both shapes of cancel.
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
import type { ActionOutcome } from "./types.js";

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
  vi.clearAllMocks();
});

/** Turns a never-resolving outcome into a fast failure instead of a timeout. */
function outcomeOrPending<T>(outcome: Promise<ActionOutcome<T>>): Promise<ActionOutcome<T>> {
  return Promise.race([
    outcome,
    new Promise<ActionOutcome<T>>((r) => {
      setTimeout(() => {
        r({ status: "error", error: { message: "outcome never settled" } });
      }, 20);
    }),
  ]);
}

describe("deduped joiner of a cancelled primary", () => {
  it("reports cancelled when the primary's run rejects on abort", async () => {
    const action = defineAction<void, string>({
      name: "dedupe.cancel_rejecting_run",
      dedupe: true,
      error: false,
      run: (_args, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });

    const primary = action.dispatch();
    const joiner = action.dispatch();
    primary.abort();

    await expect(outcomeOrPending(joiner.outcome)).resolves.toEqual({ status: "cancelled" });
    await expect(primary.outcome).resolves.toEqual({ status: "cancelled" });
  });

  it("reports cancelled when the primary's run completes after the abort", async () => {
    let release!: (v: string) => void;
    const gate = new Promise<string>((r) => {
      release = r;
    });
    const action = defineAction<void, string>({
      name: "dedupe.cancel_blind_run",
      dedupe: true,
      error: false,
      // Signal-blind: run finishes even though the dispatch was cancelled.
      run: async () => gate,
    });

    const primary = action.dispatch();
    const joiner = action.dispatch();
    primary.abort();
    release("late");

    await expect(outcomeOrPending(joiner.outcome)).resolves.toEqual({ status: "cancelled" });
    await expect(primary.outcome).resolves.toEqual({ status: "cancelled" });
  });
});

describe("dedupe: false", () => {
  it("keeps two concurrent dispatches with identical args independent", async () => {
    let calls = 0;
    let release!: (v: string) => void;
    const gate = new Promise<string>((r) => {
      release = r;
    });
    const action = defineAction<{ id: string }, string>({
      name: "dedupe.disabled",
      dedupe: false,
      run: async () => {
        calls += 1;
        return gate;
      },
    });

    const first = action.dispatch({ id: "same" });
    const second = action.dispatch({ id: "same" });
    release("ok");
    await Promise.all([first, second]);

    expect(calls).toBe(2);
  });
});
