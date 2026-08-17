// @vitest-environment happy-dom
// Definition-time guards: the duplicate-name diagnostic and the
// per-definition dedupe-key identity that prevents two same-named
// definitions from joining each other's in-flight promise (the
// cross-definition `as TResult` type-confusion hazard).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetActionFramework } from "./test-helpers/action-test-setup.js";
vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));
import { defineAction } from "./define.js";

beforeEach(() => {
  resetActionFramework();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("duplicate action names", () => {
  it("warns when a second definition reuses a name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    defineAction<void, void>({ name: "guards.dup", run: async () => undefined });
    expect(warn).not.toHaveBeenCalled();
    defineAction<void, void>({ name: "guards.dup", run: async () => undefined });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('duplicate action name "guards.dup"');
  });

  it("does not warn after a framework reset (fresh module state)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    defineAction<void, void>({ name: "guards.reset", run: async () => undefined });
    resetActionFramework();
    defineAction<void, void>({ name: "guards.reset", run: async () => undefined });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("dedupe key identity", () => {
  it("two same-named definitions never join each other's in-flight promise", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let releaseA!: (v: string) => void;
    const runA = vi.fn(
      async () =>
        new Promise<string>((r) => {
          releaseA = r;
        }),
    );
    const runB = vi.fn(async () => 42);
    // Same name, same dedupe key shape, DIFFERENT TResult — the pre-fix
    // hazard: B joining A's slot would coerce a string into its number type.
    const a = defineAction<void, string>({ name: "guards.collide", dedupe: true, run: runA });
    const b = defineAction<void, number>({ name: "guards.collide", dedupe: true, run: runB });
    const ha = a.dispatch();
    const hb = b.dispatch();
    releaseA("a-result");
    const [ra, rb] = await Promise.all([ha, hb]);
    // Both run functions executed — no cross-definition join.
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(1);
    expect(ra).toBe("a-result");
    expect(rb).toBe(42);
  });

  it("a single definition still collapses concurrent dispatches", async () => {
    let release!: (v: string) => void;
    const run = vi.fn(
      async () =>
        new Promise<string>((r) => {
          release = r;
        }),
    );
    const action = defineAction<void, string>({ name: "guards.collapse", dedupe: true, run });
    const h1 = action.dispatch();
    const h2 = action.dispatch();
    release("once");
    const [r1, r2] = await Promise.all([h1, h2]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(r1).toBe("once");
    expect(r2).toBe("once");
  });
});
