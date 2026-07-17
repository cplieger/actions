// Action registry: in-memory log of all dispatched actions with a
// subscribe API. Fires per state transition.
//
// Shape: two single-purpose structures with disjoint lifetimes, so the
// pending accounting cannot desync from log eviction by construction.
//
//   - `inflight` holds the pending dispatches. Entries live exactly as
//     long as their dispatch is in flight; the table never evicts by
//     count (only the leak watchdog reclaims past MAX_INFLIGHT), so a
//     pending entry can never be displaced by log churn.
//   - `settled` holds terminal snapshots, latest-per-dispatch-id,
//     bounded to MAX_LOG_SIZE by evicting the lowest-seq entry
//     (first-record order — the same victim the old single-array
//     shape picked).
//
// A per-dispatch monotonic `seq`, stamped at first record, orders the
// recomposed getActionLog() view identically to the old array's
// insertion order.
//
// Transition table for record(instance). The caller contract
// (define.ts) records one pending then at most one terminal per
// dispatch id, but every cell is defined so no input can desync the
// accounting:
//
//   status   | id in inflight       | id in settled          | id unknown
//   ---------|----------------------|------------------------|--------------------
//   pending  | overwrite instance   | move back to inflight  | insert (new seq),
//            | (keep seq)           | (keep seq), re-index   | index, watchdog
//   terminal | move to settled      | overwrite instance     | insert into settled
//            | (keep seq), unindex  | (keep seq + position)  | (new seq), evict
//
// Pending state (isPending / pendingCount) is mirrored into reactive signals,
// so it can be read inside an effect — bindLoadingState is a plain effect over
// these, not a bespoke subscription. The pendingByName Set index over
// `inflight` is the per-name source of truth; the signals expose the derived
// counts, and the total is `inflight.size` (membership, not paired
// arithmetic — an unpaired decrement is unrepresentable). The lifecycle
// fan-out below (record → listeners) is a discrete event stream and stays a
// plain emitter — events are not reactive state.
// ---------------------------------------------------------------------------

import { signal, batch, SignalMap } from "@cplieger/reactive";

import type { ActionInstance, RegistryListener } from "./types.js";

const MAX_LOG_SIZE = 200;

/** Leak watchdog threshold for the in-flight table. `settled` is bounded by
 *  construction, so only a dispatch that never settles (a lifecycle bug in
 *  the defining layer) can grow state — past this many in-flight entries the
 *  oldest is reclaimed with a console.warn naming it. This bounds the
 *  in-flight population specifically; the old shape's equivalent tier
 *  (MAX_LOG_HARD) bounded the combined log. */
const MAX_INFLIGHT = 1000;

interface LogEntry {
  instance: ActionInstance;
  /** Monotonic stamp assigned at the dispatch id's FIRST record; preserved
   *  across every transition so the recomposed log keeps first-record order. */
  readonly seq: number;
}

const inflight = new Map<string, LogEntry>();
const settled = new Map<string, LogEntry>();
let seqCounter = 0;

const listeners = new Set<RegistryListener>();
const namedListeners = new Map<string, Set<RegistryListener>>();
const pendingByName = new Map<string, Set<string>>();

// Reactive mirrors of the pending state. The inflight table + its name index
// remain the source of truth; these signals expose the derived counts so
// isPending/pendingCount can be read reactively (e.g. by bindLoadingState's
// effect).
const pendingSigs = new SignalMap<number>();
const pendingTotalSig = signal(0);

/** Add `id` to the name index + refresh the signals. Call AFTER the inflight
 *  mutation so `inflight.size` is current. */
function indexPending(name: string, id: string): void {
  let s = pendingByName.get(name);
  if (s === undefined) {
    s = new Set();
    pendingByName.set(name, s);
  }
  s.add(id);
  const size = s.size;
  batch(() => {
    pendingSigs.ensure(name, 0).value = size;
    pendingTotalSig.value = inflight.size;
  });
}

/** Remove `id` from the name index + refresh the signals. Call AFTER the
 *  inflight mutation. No-op when the id was never indexed. */
function unindexPending(name: string, id: string): void {
  const s = pendingByName.get(name);
  if (!s?.delete(id)) {
    return;
  }
  const size = s.size;
  if (size === 0) {
    pendingByName.delete(name);
  }
  batch(() => {
    pendingSigs.ensure(name, 0).value = size;
    pendingTotalSig.value = inflight.size;
  });
}

/** Bound `settled` by evicting the lowest-seq (first-record order) entry —
 *  the same victim the old array shape's oldest-position-first scan picked.
 *  Map insertion order alone is settle order, not first-record order (a
 *  long-pending dispatch settles late), hence the ≤ (MAX_LOG_SIZE + 1)-entry
 *  scan. `protectId` shields the entry being recorded right now, matching
 *  the old shape's `entry.id !== instance.id` eviction guard: a long-lived
 *  pending that finally settles carries the lowest seq of the whole log and
 *  would otherwise evict itself the instant it completed. */
function evictOldestSettled(protectId: string): void {
  while (settled.size > MAX_LOG_SIZE) {
    let oldestKey: string | undefined;
    let oldestSeq = Infinity;
    for (const [key, entry] of settled) {
      if (key !== protectId && entry.seq < oldestSeq) {
        oldestSeq = entry.seq;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) {
      return;
    }
    settled.delete(oldestKey);
  }
}

/** Reclaim the oldest in-flight entry once the table exceeds MAX_INFLIGHT.
 *  A dispatch that never settles is a lifecycle bug in the defining layer;
 *  the old shape reclaimed it silently at its hard tier — this names it.
 *  The reclaimed entry is dropped outright (not moved to `settled`: its
 *  status is still "pending", and the terminal log must not lie). */
function reclaimLeakedPending(): void {
  if (inflight.size <= MAX_INFLIGHT) {
    return;
  }
  let oldestKey: string | undefined;
  let oldestSeq = Infinity;
  for (const [key, entry] of inflight) {
    if (entry.seq < oldestSeq) {
      oldestSeq = entry.seq;
      oldestKey = key;
    }
  }
  if (oldestKey === undefined) {
    return;
  }
  const entry = inflight.get(oldestKey);
  inflight.delete(oldestKey);
  if (entry !== undefined) {
    unindexPending(entry.instance.name, oldestKey);
    console.warn(
      `[actions] in-flight table exceeded ${String(MAX_INFLIGHT)} entries — reclaiming oldest pending "${entry.instance.name}" (${oldestKey}). A dispatch that never settles is a bug in its action's lifecycle.`,
    );
  }
}

/** Record a state transition. Called by define.ts. */
export function record(instance: ActionInstance): void {
  const { id } = instance;
  if (instance.status === "pending") {
    const inf = inflight.get(id);
    if (inf !== undefined) {
      // Pending re-record: in-place overwrite, no accounting change.
      inf.instance = instance;
    } else {
      const done = settled.get(id);
      if (done !== undefined) {
        // Terminal → pending re-record. Not produced by define.ts (one
        // pending, then at most one terminal per id); defined anyway so no
        // input desyncs the accounting: move back, keep the original seq.
        settled.delete(id);
        done.instance = instance;
        inflight.set(id, done);
        indexPending(instance.name, id);
      } else {
        seqCounter += 1;
        inflight.set(id, { instance, seq: seqCounter });
        indexPending(instance.name, id);
        reclaimLeakedPending();
      }
    }
  } else {
    const inf = inflight.get(id);
    if (inf !== undefined) {
      // The common transition: pending → terminal. Membership moves between
      // the tables; the accounting decrements because the id LEFT inflight,
      // not because a counter was paired correctly.
      inflight.delete(id);
      unindexPending(inf.instance.name, id);
      inf.instance = instance;
      settled.set(id, inf);
      evictOldestSettled(id);
    } else {
      const done = settled.get(id);
      if (done !== undefined) {
        // Double-terminal record: latest-per-id, keep seq + position.
        done.instance = instance;
      } else {
        // Terminal-only record (cancelled before start, optimistic failure).
        seqCounter += 1;
        settled.set(id, { instance, seq: seqCounter });
        evictOldestSettled(id);
      }
    }
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
  const entries = [...inflight.values(), ...settled.values()];
  entries.sort((a, b) => a.seq - b.seq);
  return entries.map((e) => e.instance);
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
  inflight.clear();
  settled.clear();
  seqCounter = 0;
  pendingByName.clear();
  listeners.clear();
  namedListeners.clear();
  pendingSigs.clearAll();
  pendingTotalSig.value = 0;
}
