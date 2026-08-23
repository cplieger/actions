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
import { debouncedDispatch } from "./debounce.js";

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
  vi.useFakeTimers();
});

function makeAction() {
  const run = vi.fn(async (args: string) => args);
  const action = defineAction({ name: "test.debounce", run });
  return { action, run };
}

describe("debouncedDispatch — trailing (default)", () => {
  it("dispatches after the wait period", () => {
    const { action, run } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100 });
    debounced("a");
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledWith("a", expect.anything(), expect.anything());
  });

  it("coalesces rapid calls — only last args dispatched", () => {
    const { action, run } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 50 });
    debounced("a");
    debounced("b");
    debounced("c");
    vi.advanceTimersByTime(50);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("c", expect.anything(), expect.anything());
  });

  it("cancel() prevents the pending dispatch", () => {
    const { action, run } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100 });
    debounced("a");
    debounced.cancel();
    vi.advanceTimersByTime(200);
    expect(run).not.toHaveBeenCalled();
  });

  it("flush() fires immediately with pending args", () => {
    const { action, run } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100 });
    debounced("x");
    debounced.flush();
    expect(run).toHaveBeenCalledWith("x", expect.anything(), expect.anything());
  });

  it("flush(args) overrides pending args", () => {
    const { action, run } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100 });
    debounced("old");
    debounced.flush("override");
    expect(run).toHaveBeenCalledWith("override", expect.anything(), expect.anything());
  });

  it("isPending() reflects scheduled state", () => {
    const { action } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100 });
    expect(debounced.isPending()).toBe(false);
    debounced("a");
    expect(debounced.isPending()).toBe(true);
    vi.advanceTimersByTime(100);
    expect(debounced.isPending()).toBe(false);
  });
});

describe("debouncedDispatch — leading", () => {
  it("fires immediately on first call", () => {
    const { action, run } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100, leading: true });
    debounced("first");
    expect(run).toHaveBeenCalledWith("first", expect.anything(), expect.anything());
  });

  it("suppresses calls within the cooldown window", () => {
    const { action, run } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100, leading: true });
    debounced("a");
    debounced("b");
    debounced("c");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("a", expect.anything(), expect.anything());
  });

  it("fires trailing with last suppressed args after cooldown", () => {
    const { action, run } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100, leading: true });
    debounced("a");
    debounced("b");
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith("b", expect.anything(), expect.anything());
  });

  it("cancel after leading fire prevents trailing fire", () => {
    const { action, run } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100, leading: true });
    debounced("a");
    debounced("b");
    debounced.cancel();
    vi.advanceTimersByTime(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("isPending() is false during the cooldown window when nothing is scheduled", () => {
    const { action } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100, leading: true });
    debounced("a");
    // Leading edge fired; the window is pure cooldown — nothing scheduled.
    expect(debounced.isPending()).toBe(false);
    vi.advanceTimersByTime(100);
    expect(debounced.isPending()).toBe(false);
  });

  it("isPending() is true only while a suppressed call waits for the trailing fire", () => {
    const { action } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100, leading: true });
    debounced("a");
    expect(debounced.isPending()).toBe(false);
    debounced("b");
    expect(debounced.isPending()).toBe(true);
    vi.advanceTimersByTime(100);
    // "b" fired at the trailing edge; the re-armed window is cooldown only.
    expect(debounced.isPending()).toBe(false);
  });
});

describe("debouncedDispatch — flush() releases the timer and the pending flag", () => {
  it("leaves no timer armed after flushing a scheduled dispatch", () => {
    const { action, run } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100 });
    debounced("a");
    expect(vi.getTimerCount()).toBe(1);
    debounced.flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not fire a second time when the original wait elapses", () => {
    const { action, run } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100 });
    debounced("a");
    debounced.flush();
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not pull a later scheduled dispatch forward onto the discarded timer", () => {
    const { action, run } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100 });
    debounced("a");
    debounced.flush();
    vi.advanceTimersByTime(50);
    debounced("b");
    // The timer flush() discarded would have fired here, dragging "b" 50ms early.
    vi.advanceTimersByTime(50);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith("b", expect.anything(), expect.anything());
  });

  it("reports isPending() false once flushed", () => {
    const { action } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100 });
    debounced("a");
    expect(debounced.isPending()).toBe(true);
    debounced.flush();
    expect(debounced.isPending()).toBe(false);
  });

  it("counts as a leading-edge fire, so the next call is suppressed into the cooldown", () => {
    const { action, run } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100, leading: true });
    debounced("a");
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledTimes(1);

    debounced.flush("f");
    expect(run).toHaveBeenCalledTimes(2);

    debounced("b");
    // The flush restarted the quiet window, so "b" waits for the trailing edge
    // instead of firing on a leading edge of its own.
    expect(run).toHaveBeenCalledTimes(2);
    expect(debounced.isPending()).toBe(true);

    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenLastCalledWith("b", expect.anything(), expect.anything());
  });
});

describe("debouncedDispatch — cancel() releases the timer and the pending flag", () => {
  it("leaves no timer armed after cancelling a scheduled dispatch", () => {
    const { action } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100 });
    debounced("a");
    expect(vi.getTimerCount()).toBe(1);
    debounced.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer armed after cancelling a leading-edge cooldown", () => {
    const { action } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100, leading: true });
    debounced("a");
    expect(vi.getTimerCount()).toBe(1);
    debounced.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports isPending() false once cancelled", () => {
    const { action } = makeAction();
    const debounced = debouncedDispatch(action, { wait: 100 });
    debounced("a");
    expect(debounced.isPending()).toBe(true);
    debounced.cancel();
    expect(debounced.isPending()).toBe(false);
  });
});
