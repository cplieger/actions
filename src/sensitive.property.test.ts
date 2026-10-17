import { describe, it, expect, beforeEach } from "vitest";
import fc from "fast-check";
import { defineAction } from "./define.js";
import { ActionError } from "./error.js";
import { configure } from "./notifier.js";
import { getActionLog, subscribe } from "./registry.js";
import { resetActionFramework } from "./test-helpers/action-test-setup.js";

beforeEach(() => {
  resetActionFramework();
  configure({});
});

// A 24-character marker cannot occur by chance in a record's names, ids or
// timestamps, so any hit is a leak.
const marker = fc.stringMatching(/^[a-z0-9]{24}$/);

const carrying = (m: string): fc.Arbitrary<unknown> =>
  fc.oneof(
    fc.constant(m),
    fc.constant({ password: m }),
    fc.constant([m]),
    fc.constant({ form: { fields: [{ value: m }] } }),
    fc.constant(`prefix-${m}-suffix`),
  );

describe("sensitive definitions: no plaintext in the log or a listener record", () => {
  it("never serializes the marker, whatever its place or the dispatch's ending", async () => {
    await fc.assert(
      fc.asyncProperty(
        marker.chain((m) =>
          fc.record({
            m: fc.constant(m),
            args: carrying(m),
            result: carrying(m),
            ending: fc.constantFrom("success", "error", "abort"),
          }),
        ),
        async ({ m, args, result, ending }) => {
          resetActionFramework();
          configure({});
          const records: string[] = [];
          subscribe((inst) => {
            records.push(JSON.stringify(inst));
          });
          const action = defineAction<unknown, unknown>({
            name: "auth.secret",
            sensitive: true,
            error: false,
            run: (_args, signal) => {
              if (ending === "error") {
                return Promise.reject(
                  new ActionError(`refused ${m}`, { cause: { args, result }, status: 400 }),
                );
              }
              if (ending === "abort") {
                return new Promise((_resolve, reject) => {
                  signal.addEventListener("abort", () => {
                    reject(signal.reason as Error);
                  });
                });
              }
              return Promise.resolve(result);
            },
          });

          const h = action.dispatch(args);
          records.push(JSON.stringify(getActionLog()));
          if (ending === "abort") {
            h.abort();
          }
          await h;
          records.push(JSON.stringify(getActionLog()));

          expect(records.length).toBeGreaterThanOrEqual(4);
          for (const r of records) {
            expect(r).not.toContain(m);
          }
        },
      ),
    );
  });

  it("serializes the marker for the same definition without sensitive", async () => {
    await fc.assert(
      fc.asyncProperty(
        marker.chain((m) => fc.record({ m: fc.constant(m), args: carrying(m) })),
        async ({ m, args }) => {
          resetActionFramework();
          configure({});
          const action = defineAction<unknown, unknown>({
            name: "plain",
            run: () => Promise.resolve(null),
          });

          await action.dispatch(args);

          expect(JSON.stringify(getActionLog())).toContain(m);
        },
      ),
    );
  });
});
