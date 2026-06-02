import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("./notifier.js", () => ({ configure: vi.fn(), notifySuccess: vi.fn(), notifyError: vi.fn(), _resetNotifierForTest: vi.fn() }));
import { defineAction, _resetForTest as resetDefine, _internalsForTest } from "./define.js";
import { _resetForTest as resetRegistry, pendingCount, recentLog } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";

beforeEach(() => { resetDefine(); resetRegistry(); resetCleanup(); });
afterEach(() => { resetDefine(); resetRegistry(); resetCleanup(); });

describe("memory leak stress — scopeChains", () => {
  it("1000 scoped dispatches leave scopeChains empty", async () => {
    const action = defineAction({ name: "stress.scope", scope: "s", run: async () => "ok" });
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 1000; i++) { promises.push(action.dispatch({ i })); }
    await Promise.all(promises);
    expect(_internalsForTest().scopeChains).toBe(0);
  });
});

describe("memory leak stress — activeDedupes", () => {
  it("1000 deduped dispatches leave activeDedupes empty", async () => {
    let callCount = 0;
    const action = defineAction({ name: "stress.dedupe", dedupe: true, run: async (args: { v: number }) => { callCount++; return args.v; } });
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 1000; i++) { promises.push(action.dispatch({ v: i % 5 })); }
    await Promise.all(promises);
    expect(_internalsForTest().activeDedupes).toBe(0);
    expect(callCount).toBe(5);
  });
});

describe("memory leak stress — inFlight (via pendingCount)", () => {
  it("1000 parallel dispatches leave no pending entries", async () => {
    const action = defineAction({ name: "stress.parallel", run: async () => "ok" });
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 1000; i++) { promises.push(action.dispatch({ i })); }
    await Promise.all(promises);
    expect(pendingCount(["stress.parallel"])).toBe(0);
  });

  it("1000 dispatches with errors leave no pending entries", async () => {
    const action = defineAction({ name: "stress.errors", error: false, run: async () => { throw new Error("fail"); } });
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 1000; i++) { promises.push(action.dispatch({ i })); }
    await Promise.all(promises);
    expect(pendingCount(["stress.errors"])).toBe(0);
  });
});

describe("memory leak stress — combined scope + dedupe", () => {
  it("1000 scoped+deduped dispatches leave maps empty", async () => {
    const action = defineAction({ name: "stress.both", scope: "shared", dedupe: true, run: async (args: { v: number }) => args.v });
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 1000; i++) { promises.push(action.dispatch({ v: i % 3 })); }
    await Promise.all(promises);
    const internals = _internalsForTest();
    expect(internals.scopeChains).toBe(0);
    expect(internals.activeDedupes).toBe(0);
    expect(pendingCount(["stress.both"])).toBe(0);
  });
});

describe("memory leak stress — registry log eviction", () => {
  it("1000 dispatches with full lifecycle: log stays bounded at MAX_LOG_SIZE", async () => {
    const action = defineAction({ name: "stress.registry", run: async (args: { i: number }) => args.i });
    for (let i = 0; i < 1000; i++) { await action.dispatch({ i }); }
    const log = recentLog();
    expect(log.length).toBeLessThanOrEqual(200);
    expect(log.every((e) => e.status !== "pending")).toBe(true);
  });
});
