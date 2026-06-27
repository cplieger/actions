// Direct unit + property tests for the pure helpers in define-helpers.ts.
// These are exercised only indirectly via define.ts dispatch today, leaving
// the bigint / symbol / cyclic-fallback branches of safeStringify and the
// defaultErrorPrefix transform uncovered.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  safeStringify,
  symbolId,
  _resetSymbols,
  defaultErrorPrefix,
  resolveNotification,
} from "./define-helpers.js";

describe("safeStringify — primitive branches", () => {
  it("returns the literal 'undefined' for undefined", () => {
    expect(safeStringify(undefined)).toBe("undefined");
  });

  it("stringifies null/number/boolean via String()", () => {
    expect(safeStringify(null)).toBe("null");
    expect(safeStringify(42)).toBe("42");
    expect(safeStringify(-0)).toBe("0");
    expect(safeStringify(Number.NaN)).toBe("NaN");
    expect(safeStringify(true)).toBe("true");
    expect(safeStringify(false)).toBe("false");
  });

  it("JSON-quotes strings so they cannot collide with a number key", () => {
    expect(safeStringify("42")).toBe('"42"');
    expect(safeStringify("hi")).toBe('"hi"');
  });

  it("suffixes bigints with 'n' (JSON.stringify would otherwise throw)", () => {
    expect(safeStringify(10n)).toBe("10n");
    expect(safeStringify(-5n)).toBe("-5n");
  });

  it("maps symbols to a stable @@sym<id> key", () => {
    _resetSymbols();
    const a = Symbol("x");
    expect(safeStringify(a)).toBe("@@sym1");
    // Same symbol -> same key on a repeat call.
    expect(safeStringify(a)).toBe("@@sym1");
  });
});

describe("safeStringify — object branches", () => {
  it("serializes plain objects and arrays as JSON", () => {
    expect(safeStringify({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
    expect(safeStringify([1, 2, 3])).toBe("[1,2,3]");
  });

  it("replaces nested undefined with a stable __undef__ sentinel", () => {
    expect(safeStringify({ a: undefined })).toBe('{"a":"__undef__"}');
  });

  it("falls back to String() for a cyclic object instead of throwing", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;
    expect(safeStringify(cyclic)).toBe("[object Object]");
  });

  it("coerces a top-level bare function to a string, not undefined", () => {
    // JSON.stringify(fn) yields the value `undefined` (no throw), so the
    // catch never fires; safeStringify must still honor its `string` contract.
    const out = safeStringify(() => 1);
    expect(typeof out).toBe("string");
    expect(out).not.toBe("undefined");
  });

  it("gives distinct keys to functions with distinct source", () => {
    // Before the coercion fix both returned the value `undefined`, colliding
    // every function arg onto a single `${name}::undefined` dedupe key.
    const a = (x: number): number => x + 1;
    const b = (y: number): number => y * 2;
    expect(safeStringify(a)).not.toBe(safeStringify(b));
  });
});

describe("safeStringify — property: total and deterministic over arbitrary input", () => {
  it("always returns a string and never throws, even for exotic values", () => {
    // Top-level bare functions are included: JSON.stringify returns the value
    // `undefined` (not a throw) for them, so safeStringify coerces the result
    // rather than leaking `undefined` through its `string` contract.
    const exotic = fc.oneof(
      fc.anything(),
      fc.bigInt(),
      fc.constant(Symbol("s")),
      fc.func(fc.anything()),
    );
    fc.assert(
      fc.property(exotic, (value) => {
        const out = safeStringify(value);
        expect(typeof out).toBe("string");
      }),
      { numRuns: 500 },
    );
  });

  it("distinct symbols never collide into the same dedupe key", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (d1, d2) => {
        _resetSymbols();
        const s1 = Symbol(d1);
        const s2 = Symbol(d2);
        // Two distinct symbols — even with identical descriptions — must map
        // to distinct keys, or dedupe would conflate independent dispatches.
        expect(safeStringify(s1)).not.toBe(safeStringify(s2));
      }),
      { numRuns: 200 },
    );
  });
});

describe("symbolId", () => {
  it("assigns stable ids: same symbol -> same id, distinct symbols -> distinct ids", () => {
    _resetSymbols();
    const a = Symbol("a");
    const b = Symbol("a"); // same description, distinct value
    const idA = symbolId(a);
    expect(symbolId(a)).toBe(idA);
    expect(symbolId(b)).not.toBe(idA);
  });

  it("resets the counter via _resetSymbols", () => {
    _resetSymbols();
    const first = symbolId(Symbol("first"));
    _resetSymbols();
    const afterReset = symbolId(Symbol("again"));
    expect(afterReset).toBe(first);
  });
});

describe("defaultErrorPrefix", () => {
  it("takes the dotted tail, humanizes separators, capitalizes, and appends ' failed'", () => {
    expect(defaultErrorPrefix("chat.delete")).toBe("Delete failed");
    expect(defaultErrorPrefix("files.create")).toBe("Create failed");
    expect(defaultErrorPrefix("upload")).toBe("Upload failed");
    expect(defaultErrorPrefix("user.profile_update")).toBe("Profile update failed");
    expect(defaultErrorPrefix("git-push")).toBe("Git push failed");
  });

  it("handles an empty name without throwing", () => {
    expect(defaultErrorPrefix("")).toBe(" failed");
  });
});

describe("resolveNotification", () => {
  it("returns null when the spec is false (suppressed)", () => {
    expect(resolveNotification(false, "args", "payload")).toBeNull();
  });

  it("returns the fallback (or null) when the spec is undefined", () => {
    expect(resolveNotification(undefined, "args", "payload")).toBeNull();
    expect(resolveNotification(undefined, "args", "payload", "fb")).toBe("fb");
  });

  it("returns a literal string spec as-is", () => {
    expect(resolveNotification("Saved", "args", "payload")).toBe("Saved");
  });

  it("invokes a function spec with args and payload", () => {
    const spec = (a: string, p: number): string => `${a}:${String(p)}`;
    expect(resolveNotification(spec, "item", 7)).toBe("item:7");
  });
});
