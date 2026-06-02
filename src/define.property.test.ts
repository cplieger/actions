// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";
vi.mock("./notifier.js", () => ({ configure: vi.fn(), notifySuccess: vi.fn(), notifyError: vi.fn(), _resetNotifierForTest: vi.fn() }));
import { defineAction, _resetForTest as resetDefine } from "./define.js";
import { _resetForTest as resetRegistry } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";

beforeEach(() => { resetDefine(); resetRegistry(); resetCleanup(); vi.clearAllMocks(); });

describe("scope serialization property", () => {
  it("for any N dispatches with same scope key, runs execute sequentially and all resolve", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (n) => {
      resetDefine(); resetRegistry(); resetCleanup();
      const timeline: { idx: number; event: "start" | "end" }[] = [];
      let counter = 0;
      const action = defineAction<number, number>({ name: "prop.scope_serial", scope: "serial", error: false, run: async (args) => { const idx = args; timeline.push({ idx, event: "start" }); await new Promise((r) => setTimeout(r, 1)); timeline.push({ idx, event: "end" }); return counter++; } });
      const promises = Array.from({ length: n }, (_, i) => action.dispatch(i));
      const results = await Promise.all(promises);
      expect(results).toHaveLength(n);
      for (const r of results) { expect(r).not.toBeNull(); }
      for (let i = 0; i < timeline.length; i += 2) { expect(timeline[i]!.event).toBe("start"); expect(timeline[i + 1]?.event).toBe("end"); }
    }), { numRuns: 20 });
  });
});

describe("dedupe property", () => {
  it("for any N dispatches with dedupe:true and same args, at most one run is in-flight", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (n) => {
      resetDefine(); resetRegistry(); resetCleanup();
      let inFlight = 0;
      let maxInFlight = 0;
      let runCount = 0;
      const action = defineAction<string, string>({ name: "prop.dedupe", dedupe: true, error: false, run: async () => { inFlight++; runCount++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return "ok"; } });
      const promises = Array.from({ length: n }, () => action.dispatch("same"));
      const results = await Promise.all(promises);
      expect(maxInFlight).toBe(1);
      for (const r of results) { expect(r).toBe("ok"); }
      expect(runCount).toBe(1);
    }), { numRuns: 20 });
  });
});

describe("cancellation property", () => {
  it("cancel during any lifecycle phase transitions to cancelled and returns null", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("immediate", "during-run"), async (phase) => {
      resetDefine(); resetRegistry(); resetCleanup();
      let runStarted = false;
      const action = defineAction<string, string>({ name: "prop.cancel", error: false, run: async (_args, signal) => { runStarted = true; return new Promise<string>((_resolve, reject) => { signal.addEventListener("abort", () => { reject(new DOMException("aborted", "AbortError")); }, { once: true }); }); } });
      if (phase === "immediate") {
        const p = action.dispatch("x");
        action.cancel();
        expect(await p).toBeNull();
      } else {
        const p = action.dispatch("x");
        await new Promise((r) => setTimeout(r, 1));
        expect(runStarted).toBe(true);
        action.cancel();
        expect(await p).toBeNull();
      }
    }), { numRuns: 15 });
  });
});
