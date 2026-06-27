// @vitest-environment happy-dom
// Model-based property test for registry pending accounting. Drives arbitrary
// record() sequences and checks the pending invariants the table tests only
// spot-check: pendingCount() never goes negative, matches a last-status model
// oracle, stays consistent with isPending/pendingCount([name]), and the log
// never exposes a tombstoned (null) slot.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { record, pendingCount, isPending, recentLog, _resetForTest } from "./registry.js";
import type { ActionLifecycleStatus } from "./types.js";

const STATUSES: readonly ActionLifecycleStatus[] = ["pending", "success", "error", "cancelled"];

describe("registry pending-accounting property", () => {
  it("pendingCount matches the last-status model and never goes negative", () => {
    const op = fc.record({
      id: fc.integer({ min: 0, max: 24 }),
      status: fc.constantFrom(...STATUSES),
    });
    fc.assert(
      // Distinct ids bounded to 25 and length to 120 keeps the live set well
      // under MAX_LOG_SIZE (200), so no eviction fires and the model is exact.
      // Each id maps to ONE stable name (id % 5): production ids are unique per
      // dispatch and embed their action name, so an id never changes name.
      fc.property(fc.array(op, { minLength: 0, maxLength: 120 }), (ops) => {
        _resetForTest();
        const lastStatus = new Map<string, ActionLifecycleStatus>();
        const lastName = new Map<string, string>();
        for (const o of ops) {
          const id = `id-${String(o.id)}`;
          const name = `name-${String(o.id % 5)}`;
          record({
            id,
            name,
            status: o.status,
            args: {},
            dispatchedAt: 0,
            startedAt: 0,
          });
          lastStatus.set(id, o.status);
          lastName.set(id, name);
        }

        // Model oracle: an id is pending iff its last recorded status is pending.
        let modelPending = 0;
        const perName = new Map<string, number>();
        for (const [id, status] of lastStatus) {
          if (status === "pending") {
            modelPending += 1;
            const nm = lastName.get(id)!;
            perName.set(nm, (perName.get(nm) ?? 0) + 1);
          }
        }

        expect(pendingCount()).toBeGreaterThanOrEqual(0);
        expect(pendingCount()).toBe(modelPending);

        for (const nm of new Set(lastName.values())) {
          const expected = perName.get(nm) ?? 0;
          expect(pendingCount([nm])).toBe(expected);
          expect(isPending(nm)).toBe(expected > 0);
        }

        // Tombstone invariant: the snapshot never exposes a null/undefined slot.
        for (const entry of recentLog()) {
          expect(entry).not.toBeNull();
          expect(entry).not.toBeUndefined();
        }
      }),
      { numRuns: 300 },
    );
  });
});
