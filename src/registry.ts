// Action registry: in-memory log of all dispatched actions with a
// subscribe API. Fires per state transition. Bounded to a recent
// window so memory usage stays flat over a long session.
//
// Performance: eviction uses a head-pointer + tombstones instead of
// splice + O(n) index re-computation. record() is O(1) amortized.
// ---------------------------------------------------------------------------

import type { ActionInstance, RegistryListener } from "./types.js";

const MAX_LOG_SIZE = 200;
const MAX_LOG_HARD = MAX_LOG_SIZE * 5;

const log: (ActionInstance | null)[] = [];
interface LogSlot {
  instance: ActionInstance;
  index: number;
}
const idMap = new Map<string, LogSlot>();
const listeners = new Set<RegistryListener>();
const namedListeners = new Map<string, Set<RegistryListener>>();
const pendingByName = new Map<string, Set<string>>();
let _pendingTotal = 0;
let _liveCount = 0;
let _head = 0;

function compact(): void {
  while (_head < log.length && log[_head] === null) {
    _head++;
  }
  if (_head > 256) {
    log.splice(0, _head);
    for (const entry of idMap.values()) {
      entry.index -= _head;
    }
    _head = 0;
  }
}

/** Record a state transition. Called by define.ts. */
export function record(instance: ActionInstance): void {
  const existing = idMap.get(instance.id);
  if (existing !== undefined) {
    const prev = existing.instance;
    if (prev.status === "pending" && instance.status !== "pending") {
      _pendingTotal--;
      const s = pendingByName.get(prev.name);
      if (s !== undefined) {
        s.delete(instance.id);
        if (s.size === 0) {
          pendingByName.delete(prev.name);
        }
      }
    } else if (prev.status !== "pending" && instance.status === "pending") {
      _pendingTotal++;
      let s = pendingByName.get(instance.name);
      if (s === undefined) {
        s = new Set();
        pendingByName.set(instance.name, s);
      }
      s.add(instance.id);
    }
    log[existing.index] = instance;
    existing.instance = instance;
    if (instance.status !== "pending" && _liveCount > MAX_LOG_SIZE) {
      for (let i = _head; i < log.length; i++) {
        const entry = log[i];
        if (
          entry !== null &&
          entry !== undefined &&
          entry.status !== "pending" &&
          entry.id !== instance.id
        ) {
          idMap.delete(entry.id);
          log[i] = null;
          _liveCount--;
          if (_liveCount <= MAX_LOG_SIZE) {
            break;
          }
        }
      }
      compact();
    }
  } else {
    const idx = log.length;
    log.push(instance);
    idMap.set(instance.id, { instance, index: idx });
    _liveCount++;
    if (instance.status === "pending") {
      _pendingTotal++;
      let s = pendingByName.get(instance.name);
      if (s === undefined) {
        s = new Set();
        pendingByName.set(instance.name, s);
      }
      s.add(instance.id);
    }
    if (_liveCount > MAX_LOG_SIZE) {
      for (let i = _head; i < log.length; i++) {
        const entry = log[i];
        if (entry !== null && entry !== undefined && entry.status !== "pending") {
          idMap.delete(entry.id);
          log[i] = null;
          _liveCount--;
          break;
        }
      }
    }
    if (_liveCount > MAX_LOG_HARD) {
      for (let i = _head; i < log.length; i++) {
        const entry = log[i];
        if (entry !== null && entry !== undefined) {
          if (entry.status === "pending") {
            _pendingTotal--;
            const s = pendingByName.get(entry.name);
            if (s !== undefined) {
              s.delete(entry.id);
              if (s.size === 0) {
                pendingByName.delete(entry.name);
              }
            }
          }
          idMap.delete(entry.id);
          log[i] = null;
          _liveCount--;
          break;
        }
      }
    }
    compact();
  }
  if (_pendingTotal < 0) {
    console.warn("[actions] _pendingTotal went negative — invariant violation; clamping to 0");
    _pendingTotal = 0;
  }
  for (const fn of listeners) {
    try {
      fn(instance);
    } catch (e) {
      console.error("[actions] registry listener threw", e);
    }
  }
  const named = namedListeners.get(instance.name);
  if (named !== undefined) {
    for (const fn of named) {
      try {
        fn(instance);
      } catch (e) {
        console.error("[actions] registry listener threw", e);
      }
    }
  }
}

/** Subscribe to all action lifecycle events. */
export function subscribe(fn: RegistryListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Subscribe to lifecycle events for a single action name. */
export function subscribeByName(name: string, fn: RegistryListener): () => void {
  let set = namedListeners.get(name);
  if (set === undefined) {
    set = new Set();
    namedListeners.set(name, set);
  }
  set.add(fn);
  const captured = set;
  return () => {
    captured.delete(fn);
    if (captured.size === 0 && namedListeners.get(name) === captured) {
      namedListeners.delete(name);
    }
  };
}

/** @internal Test-only public surface. */
export function recentLog(): readonly ActionInstance[] {
  const result: ActionInstance[] = [];
  for (let i = _head; i < log.length; i++) {
    const entry = log[i];
    if (entry != null) {
      result.push(entry);
    }
  }
  return result;
}

/** Read the recent action log. Useful for devtools integration and
 *  debugging panels. Returns a snapshot of all live entries. */
export const getActionLog = recentLog;

/** O(1) check: true if at least one instance of the named action is pending. */
export function isPending(name: string): boolean {
  const s = pendingByName.get(name);
  return s !== undefined && s.size > 0;
}

/** Pending count for action(s). */
export function pendingCount(names?: readonly string[]): number {
  if (names === undefined) {
    return _pendingTotal;
  }
  let total = 0;
  for (const name of names) {
    const s = pendingByName.get(name);
    if (s !== undefined) {
      total += s.size;
    }
  }
  return total;
}

/** Test-only: clear log + listeners. */
export function _resetForTest(): void {
  log.length = 0;
  _head = 0;
  _liveCount = 0;
  idMap.clear();
  pendingByName.clear();
  listeners.clear();
  namedListeners.clear();
  _pendingTotal = 0;
}
