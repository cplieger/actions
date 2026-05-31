// Global cleanup: cancel all in-flight actions + run registered
// cleanup hooks. Wired to window.beforeunload.
// ---------------------------------------------------------------------------

import type { Action } from "./types.js";

interface Cancellable {
  readonly name: string;
  cancel(): void;
}

const trackedActions = new Set<Cancellable>();
const cleanupHooks = new Set<() => void>();
let beforeunloadInstalled = false;

/** Internal: register an Action so cancelAllPending() can iterate it. */
export function _registerAction<TArgs, TResult>(action: Action<TArgs, TResult>): void {
  trackedActions.add(action);
  installBeforeunloadOnce();
}

/**
 * Register a cleanup function to run on page unload (or test invoke).
 */
export function registerCleanup(fn: () => void): () => void {
  cleanupHooks.add(fn);
  installBeforeunloadOnce();
  return () => cleanupHooks.delete(fn);
}

function cancelAllPending(): void {
  for (const action of trackedActions) {
    try {
      action.cancel();
    } catch (e) {
      console.error(`[actions] cancel for ${action.name} threw`, e);
    }
  }
  for (const fn of [...cleanupHooks]) {
    try {
      fn();
    } catch (e) {
      console.error("[actions] cleanup hook threw", e);
    }
  }
}

function installBeforeunloadOnce(): void {
  if (beforeunloadInstalled) {
    return;
  }
  beforeunloadInstalled = true;
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", cancelAllPending);
  }
}

/** Test-only: invoke the same cleanup logic that beforeunload runs. */
export function _cancelAllForTest(): void {
  cancelAllPending();
}

/** Test-only: clear both registries + uninstall the listener. */
export function _resetForTest(): void {
  trackedActions.clear();
  cleanupHooks.clear();
  if (beforeunloadInstalled && typeof window !== "undefined") {
    window.removeEventListener("beforeunload", cancelAllPending);
  }
  beforeunloadInstalled = false;
}
