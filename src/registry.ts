import { signal, batch, SignalMap } from "@cplieger/reactive";

import type { ActionInstance, RegistryListener } from "./types.js";

const MAX_LOG_SIZE = 200;

/** Only a dispatch that never settles can grow `inflight` past this; the
 *  oldest is then reclaimed with a console.warn naming it. */
const MAX_INFLIGHT = 1000;

interface LogEntry {
  instance: ActionInstance;
  /** Monotonic stamp assigned at the dispatch id's FIRST record; preserved
   *  across every transition so the recomposed log keeps first-record order. */
  readonly seq: number;
}

// Disjoint lifetimes keep pending accounting from desyncing with log
// eviction: `inflight` holds pending dispatches (reclaimed only past
// MAX_INFLIGHT), `settled` terminal snapshots, latest per id, bounded to
// MAX_LOG_SIZE by evicting the lowest `seq`. `seq`, stamped at an id's first
// record, orders getActionLog(); pendingByName indexes `inflight`.
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

/** Evicts the lowest-seq (first-record order) entry. Map insertion order
 *  alone is settle order, not first-record order (a long-pending dispatch
 *  settles late), hence the linear scan. `protectId` shields the entry being
 *  recorded right now: a long-lived pending that finally settles can carry
 *  the lowest seq of the whole log and would otherwise evict itself. */
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

/** Reclaims the oldest in-flight entry once the table exceeds MAX_INFLIGHT,
 *  skipping `protectId` (a revived entry keeps its original, possibly-lowest
 *  seq, and must not reclaim itself). Dropped outright, never moved to
 *  `settled`: its status is still "pending" and the terminal log must not lie. */
function reclaimLeakedPending(protectId: string): void {
  if (inflight.size <= MAX_INFLIGHT) {
    return;
  }
  let oldestKey: string | undefined;
  let oldestSeq = Infinity;
  for (const [key, entry] of inflight) {
    if (key !== protectId && entry.seq < oldestSeq) {
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
      `[actions] in-flight capacity exceeded (${String(MAX_INFLIGHT)} entries) — reclaiming oldest pending "${entry.instance.name}" (${oldestKey}). Check for dispatches that never settle.`,
    );
  }
}

/** Record a state transition. Each cell completes its map moves before
 *  publishing signals, so a reentrant record from an effect sees coherent state:
 *
 *    status   | in inflight          | in settled             | unknown
 *    pending  | overwrite (keep seq) | move back, re-index    | insert, index, watchdog
 *    terminal | move to settled,     | overwrite (keep seq    | insert into settled,
 *             | unindex              | and position)          | evict */
export function record(instance: ActionInstance): void {
  const { id } = instance;
  if (instance.status === "pending") {
    const inf = inflight.get(id);
    if (inf !== undefined) {
      inf.instance = instance;
    } else {
      const done = settled.get(id);
      if (done !== undefined) {
        settled.delete(id);
        done.instance = instance;
        inflight.set(id, done);
        indexPending(instance.name, id);
        reclaimLeakedPending(id);
      } else {
        seqCounter += 1;
        inflight.set(id, { instance, seq: seqCounter });
        indexPending(instance.name, id);
        reclaimLeakedPending(id);
      }
    }
  } else {
    const inf = inflight.get(id);
    if (inf !== undefined) {
      // Entry must be fully moved before unindexPending publishes signals:
      // reactive effects flush synchronously at that batch's end, and a
      // reentrant same-id record from one must find it in `settled` (the
      // revive cell) rather than minting a duplicate wrapper.
      const indexedName = inf.instance.name;
      inflight.delete(id);
      inf.instance = instance;
      settled.set(id, inf);
      evictOldestSettled(id);
      unindexPending(indexedName, id);
    } else {
      const done = settled.get(id);
      if (done !== undefined) {
        done.instance = instance;
      } else {
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

/** Read the recent action log. Useful for devtools integration and
 *  debugging panels. Returns a snapshot of all live entries.
 *
 *  SECURITY/PRIVACY: each entry retains the dispatch's `args`, `result` and
 *  `error` (up to MAX_LOG_SIZE settled entries plus every in-flight dispatch,
 *  watchdog-bounded at MAX_INFLIGHT), and every listener receives them. A
 *  definition whose args or result carry a secret, token or PII sets
 *  `sensitive`, whose entries hold none of the three. */
export function getActionLog(): readonly ActionInstance[] {
  const entries = [...inflight.values(), ...settled.values()];
  entries.sort((a, b) => a.seq - b.seq);
  return entries.map((e) => e.instance);
}

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
