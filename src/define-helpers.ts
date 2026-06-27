// ---------------------------------------------------------------------------
// Pure utility helpers extracted from define.ts — independently testable
// without instantiating the full action framework.
// ---------------------------------------------------------------------------

import type { NotificationSpec } from "./types.js";

/** Invoke a callback safely — errors are caught and logged without
 *  disrupting the dispatch lifecycle. */
export function safeInvoke(actionName: string, hookName: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error(`[actions] ${hookName} callback for ${actionName} threw`, e);
  }
}

/** Monotonic counter for symbol identity in dedupe keys. Symbols with
 *  the same description are distinct values but String(sym) is identical,
 *  so we assign each unique symbol a stable numeric ID. */
let _symbolCounter = 0;
const _symbolMap = new Map<symbol, number>();
export function symbolId(sym: symbol): number {
  let id = _symbolMap.get(sym);
  if (id === undefined) {
    id = ++_symbolCounter;
    _symbolMap.set(sym, id);
  }
  return id;
}

/** Reset symbol state — test-only. */
export function _resetSymbols(): void {
  _symbolCounter = 0;
  _symbolMap.clear();
}

/** Defensive JSON.stringify — falls back to String(args) on cycles
 *  or non-serializable values (DOM elements, functions). Used by
 *  the default dedupe key computation. */
export function safeStringify(args: unknown): string {
  if (args === undefined) {
    return "undefined";
  }
  if (args === null || typeof args === "number" || typeof args === "boolean") {
    return String(args);
  }
  if (typeof args === "string") {
    return JSON.stringify(args);
  }
  if (typeof args === "bigint") {
    return `${String(args)}n`;
  }
  if (typeof args === "symbol") {
    return `@@sym${String(symbolId(args))}`;
  }
  try {
    const out = JSON.stringify(args, (_key, value: unknown) =>
      value === undefined ? "__undef__" : value,
    );
    // A top-level non-serializable value (a bare function) makes JSON.stringify
    // return the value `undefined` rather than throw, so the catch never fires.
    // Coerce to a stable string so distinct function args don't collide on a
    // single `${name}::undefined` dedupe key.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- intentional fallback for non-serializable values
    return typeof out === "string" ? out : String(args);
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- intentional fallback for cyclic objects
    return String(args);
  }
}

/** Resolve a NotificationSpec to its message string. Returns null when
 *  the spec is `false` (suppressed) or undefined and no fallback. */
export function resolveNotification<TArgs, TPayload>(
  spec: NotificationSpec<TArgs, TPayload> | undefined,
  args: TArgs,
  payload: TPayload,
  fallback?: string,
): string | null {
  if (spec === false) {
    return null;
  }
  if (spec === undefined) {
    return fallback ?? null;
  }
  if (typeof spec === "string") {
    return spec;
  }
  return spec(args, payload);
}

/** Build a default error notification prefix from the action name.
 *  Converts "chat.delete" -> "Delete failed". */
export function defaultErrorPrefix(name: string): string {
  const parts = name.split(".");
  const tail = parts[parts.length - 1] ?? name;
  const readable = tail.replace(/[_-]/g, " ");
  return readable.charAt(0).toUpperCase() + readable.slice(1) + " failed";
}
