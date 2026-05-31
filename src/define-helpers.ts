// Pure utility helpers extracted from define.ts.
// ---------------------------------------------------------------------------

import type { ToastSpec } from "./types.js";

/** Invoke a callback safely — errors are caught and logged. */
export function safeInvoke(actionName: string, hookName: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error(`[actions] ${hookName} callback for ${actionName} threw`, e);
  }
}

/** Monotonic counter for symbol identity in dedupe keys. */
let _symbolCounter = 0;
export const _symbolMap = new Map<symbol, number>();
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

/** Defensive JSON.stringify — falls back to String(args) on cycles. */
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
    return JSON.stringify(args, (_key, value: unknown) =>
      value === undefined ? "__undef__" : value,
    );
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- intentional fallback for cyclic objects
    return String(args);
  }
}

/** Resolve a ToastSpec to its message string. Returns null when suppressed. */
export function resolveToast<TArgs, TPayload>(
  spec: ToastSpec<TArgs, TPayload> | undefined,
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

/** Build a default error toast prefix from the action name. */
export function defaultErrorPrefix(name: string): string {
  const parts = name.split(".");
  const tail = parts[parts.length - 1] ?? name;
  const readable = tail.replace(/[_-]/g, " ");
  return readable.charAt(0).toUpperCase() + readable.slice(1) + " failed";
}
