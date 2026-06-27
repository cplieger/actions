// Action registry: in-memory log of all dispatched actions with a
// subscribe API. Fires per state transition. Bounded to a recent
// window so memory usage stays flat over a long session.
//
// Performance: eviction uses a head-pointer + tombstones instead of
// splice + O(n) index re-computation. record() is O(1) amortized.
//
// Pending state (isPending / pendingCount) is mirrored into reactive signals,
// so it can be read inside an effect — bindLoadingState is a plain effect over
// these, not a bespoke subscription. The pendingByName Set stays the source of
// truth for which ids are in flight; the signals expose the derived counts.
// The lifecycle fan-out below (record → listeners) is a discrete event stream
// and stays a plain emitter — events are not reactive state.
// ---------------------------------------------------------------------------

import { signal, batch, SignalMap } from "@cplieger/reactive";

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

// Test-only: when true, a detected _pendingTotal underflow throws instead of
// the production warn + clamp, so an add/removePending pairing bug surfaces in
// tests rather than being silently masked. Production default is false.
// Toggled via _setThrowOnInvariantViolationForTest (same _*ForTest convention
// as _resetForTest); reset to false by _resetForTest.
let _throwOnInvariantViolation = false;

// Reactive mirrors of the pending state. pendingByName remains the source of
// truth; these signals expose the derived counts so isPending/pendingCount can
// be read reactively (e.g. by bindLoadingState's effect).
const pendingSigs = new SignalMap<number>();
const pendingTotalSig = signal(0);

function addPending(name: string, id: string): void {
  let s = pendingByName.get(name);
  if (s === undefined) {
    s = new Set();
    pendingByName.set(name, s);
  }
  if (s.has(id)) {
    return;
  }
  s.add(id);
  _pendingTotal++;
  const size = s.size;
  batch(() => {
    pendingSigs.ensure(name, 0).value = size;
    pendingTotalSig.value = _pendingTotal;
  });
}

function removePending(name: string, id: string): void {
  const s = pendingByName.get(name);
  if (!s?.delete(id)) {
    return;
  }
  _pendingTotal--;
  const size = s.size;
  if (size === 0) {
    pendingByName.delete(name);
  }
  batch(() => {
    pendingSigs.ensure(name, 0).value = size;
    pendingTotalSig.value = _pendingTotal;
  });
}

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
      removePending(prev.name, instance.id);
    } else if (prev.status !== "pending" && instance.status === "pending") {
      addPending(instance.name, instance.id);
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
      addPending(instance.name, instance.id);
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
            removePending(entry.name, entry.id);
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
    if (_throwOnInvariantViolation) {
      throw new Error("[actions] _pendingTotal went negative — invariant violation");
    }
    console.warn("[actions] _pendingTotal went negative — invariant violation; clamping to 0");
    _pendingTotal = 0;
    pendingTotalSig.value = 0;
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
 *  debugging panels. Returns a snapshot of all live entries.
 *
 *  SECURITY/PRIVACY: each entry retains the full dispatch `args` in memory (up to
 *  MAX_LOG_SIZE entries), `subscribeToActions` fans `args` out to every listener, and
 *  buildRetryButton retains a structuredClone of `args` in the error-notification
 *  retry closure. Do NOT put secrets, tokens, or PII in action args. */
export const getActionLog = recentLog;

/** O(1) check: true if at least one instance of the named action is pending.
 *  Reactive — reading inside an effect tracks the name's pending signal. */
export function isPending(name: string): boolean {
  return pendingSigs.ensure(name, 0).value > 0;
}

/** Pending count for action(s). Reactive — reads track the relevant signals. */
export function pendingCount(names?: readonly string[]): number {
  if (names === undefined) {
    return pendingTotalSig.value;
  }
  let total = 0;
  for (const name of names) {
    total += pendingSigs.ensure(name, 0).value;
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
  _throwOnInvariantViolation = false;
  pendingSigs.clearAll();
  pendingTotalSig.value = 0;
}

/**
 * @internal Test-only: toggle whether a detected `_pendingTotal` underflow
 * throws (true) instead of the production warn + clamp (false). Lets tests
 * assert that an add/removePending pairing bug surfaces loudly. Reset to false
 * by `_resetForTest`.
 */
export function _setThrowOnInvariantViolationForTest(enabled: boolean): void {
  _throwOnInvariantViolation = enabled;
}

/**
 * @internal Test-only: simulate an unpaired `removePending` (an add/remove
 * mismatch) by decrementing the pending total without a matching add, driving
 * the invariant negative. The next `record()` then hits the clamp branch.
 */
export function _forcePendingUnderflowForTest(): void {
  _pendingTotal--;
}
