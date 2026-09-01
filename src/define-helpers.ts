import type { NotificationSpec } from "./types.js";

/** Errors are caught and logged; never disrupts the dispatch lifecycle. */
export function safeInvoke(actionName: string, hookName: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error(`[actions] ${hookName} callback for ${actionName} threw`, e);
  }
}

// Symbols with the same description are distinct values but String(sym) is
// identical, so each unique symbol needs its own stable numeric id.
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

export function _resetSymbols(): void {
  _symbolCounter = 0;
  _symbolMap.clear();
}

/** Falls back to String(args) on cycles or non-serializable values. */
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
    // A bare function makes JSON.stringify return `undefined` rather than throw,
    // so the catch never fires; coerce so distinct functions don't collide on
    // one dedupe key.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- intentional fallback for non-serializable values
    return typeof out === "string" ? out : String(args);
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- intentional fallback for cyclic objects
    return String(args);
  }
}

/** Returns null when spec is `false` (suppressed) or undefined with no fallback. */
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

/** "chat.delete" -> "Delete failed". */
export function defaultErrorPrefix(name: string): string {
  const parts = name.split(".");
  const tail = parts[parts.length - 1] ?? name;
  const readable = tail.replace(/[_-]/g, " ");
  return readable.charAt(0).toUpperCase() + readable.slice(1) + " failed";
}
