// defineAction: the lifecycle runner. Takes an ActionDefinition,
// returns an Action whose dispatch() executes the full lifecycle.
// ---------------------------------------------------------------------------

import { notifyError, notifySuccess } from "./notifier.js";
import { toActionError } from "./error.js";
import { record } from "./registry.js";
import { sleep, waitForOnline, attachAttempts, readAttempts } from "./retry.js";
import { _registerAction } from "./cleanup.js";
import {
  safeInvoke,
  safeStringify,
  _symbolMap,
  _resetSymbols,
  resolveToast,
  defaultErrorPrefix,
} from "./define-helpers.js";
import type {
  Action,
  ActionContext,
  ActionDefinition,
  ActionErrorLike,
  DispatchOptions,
} from "./types.js";

let instanceCounter = 0;

const NO_OPTS = Object.freeze({}) as DispatchOptions;
const NOOP = (): void => {
  /* noop */
};

function nextInstanceID(name: string): string {
  instanceCounter += 1;
  return `${name}#${String(instanceCounter)}`;
}

/** Header name used by apiAction when an idempotency key is generated. */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";

function generateIdempotencyKey(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 16).padEnd(14, "0");
  return `${ts}-${rnd}`;
}

const scopeChains = new Map<string, Promise<unknown>>();

interface DedupeSlot {
  promise: Promise<unknown> | undefined;
  error?: ActionErrorLike;
  cancelled?: boolean;
}
const activeDedupes = new Map<string, DedupeSlot>();

/**
 * Create an action from a declarative definition.
 */
export function defineAction<TArgs, TResult, TOp = unknown>(
  def: ActionDefinition<TArgs, TResult, TOp>,
): Action<TArgs, TResult> {
  const inFlight = new Map<string, AbortController>();
  const started = new Set<string>();
  const scopeSkipResolvers = new Map<string, () => void>();
  const scopePrevs = new Map<string, Promise<unknown>>();
  const scopeCancelResolvers = new Map<string, () => void>();
  const activeDedupeKeys = new Set<string>();

  function dispatch(
    args: TArgs,
    opts: DispatchOptions<TArgs, TResult> = NO_OPTS,
  ): Promise<TResult | null> {
    const dedupeKey = dedupeKeyFor(args);
    if (dedupeKey !== null) {
      const entry = activeDedupes.get(dedupeKey);
      if (entry !== undefined) {
        const shared = entry.promise;
        if (shared === undefined) {
          if (opts.onSettled) {
            safeInvoke(def.name, "onSettled", () => {
              opts.onSettled!(args);
            });
          }
          return Promise.resolve(null);
        }
        return (shared as Promise<TResult | null>).then(
          (v) => {
            if (v !== null) {
              if (opts.onSuccess) {
                safeInvoke(def.name, "onSuccess", () => {
                  opts.onSuccess!(v, args);
                });
              }
            } else if (entry.error !== undefined) {
              const capturedErr = entry.error;
              if (opts.onError) {
                safeInvoke(def.name, "onError", () => {
                  opts.onError!(capturedErr, args);
                });
              }
            } else if (entry.cancelled !== true) {
              if (opts.onError) {
                safeInvoke(def.name, "onError", () => {
                  opts.onError!(
                    { message: "deduped dispatch did not succeed", code: "dedupe" },
                    args,
                  );
                });
              }
            }
            if (opts.onSettled) {
              safeInvoke(def.name, "onSettled", () => {
                opts.onSettled!(args);
              });
            }
            return v;
          },
          () => {
            if (opts.onSettled) {
              safeInvoke(def.name, "onSettled", () => {
                opts.onSettled!(args);
              });
            }
            return null;
          },
        );
      }
    }

    const scopeKey =
      typeof def.scope === "function"
        ? def.scope(args)
        : typeof def.scope === "string"
          ? def.scope
          : null;

    const ac = new AbortController();
    const id = nextInstanceID(def.name);
    inFlight.set(id, ac);
    const dispatchedAt = Date.now();

    const dedupeEntry: DedupeSlot | null = dedupeKey !== null ? { promise: undefined } : null;

    let result: Promise<TResult | null>;
    if (scopeKey === null) {
      result = runOnce(args, opts, ac, id, dedupeEntry, dedupeKey, dispatchedAt);
    } else {
      const prev = scopeChains.get(scopeKey) ?? Promise.resolve();
      const next = prev.then(() =>
        runOnce(args, opts, ac, id, dedupeEntry, dedupeKey, dispatchedAt),
      );
      let tailResolve!: () => void;
      const tail = new Promise<void>((r) => {
        tailResolve = r;
      });
      scopeSkipResolvers.set(id, tailResolve);
      scopePrevs.set(id, prev);
      void next.then(tailResolve, tailResolve);
      scopeChains.set(scopeKey, tail);
      void next
        .finally(() => {
          scopeSkipResolvers.delete(id);
          scopeCancelResolvers.delete(id);
          scopePrevs.delete(id);
          if (scopeChains.get(scopeKey) === tail) {
            scopeChains.delete(scopeKey);
          }
        })
        .catch(NOOP);
      let earlyCancelResolve!: (v: TResult | null) => void;
      const earlyCancel = new Promise<TResult | null>((r) => {
        earlyCancelResolve = r;
      });
      scopeCancelResolvers.set(id, () => {
        try {
          const now = Date.now();
          if (dedupeEntry !== null) {
            dedupeEntry.cancelled = true;
          }
          evictDedupeSlot(dedupeKey, dedupeEntry);
          record({
            id,
            name: def.name,
            status: "cancelled",
            args,
            dispatchedAt,
            startedAt: now,
            completedAt: now,
          });
        } finally {
          if (opts.onSettled) {
            safeInvoke(def.name, "onSettled", () => {
              opts.onSettled!(args);
            });
          }
          earlyCancelResolve(null);
        }
      });
      result = Promise.race([next, earlyCancel]);
    }

    if (dedupeKey !== null && dedupeEntry !== null) {
      dedupeEntry.promise = result;
      activeDedupes.set(dedupeKey, dedupeEntry);
      activeDedupeKeys.add(dedupeKey);
      void result.finally(() => {
        if (activeDedupes.get(dedupeKey) === dedupeEntry) {
          activeDedupes.delete(dedupeKey);
          activeDedupeKeys.delete(dedupeKey);
        }
      });
    }

    return result;
  }

  function dedupeKeyFor(args: TArgs): string | null {
    const cfg = def.dedupe;
    if (cfg === undefined || cfg === false) {
      return null;
    }
    const argKey = typeof cfg === "function" ? cfg(args) : safeStringify(args);
    return `${def.name}::${argKey}`;
  }

  function evictDedupeSlot(dk: string | null, entry: DedupeSlot | null): void {
    if (dk !== null && entry !== null && activeDedupes.get(dk) === entry) {
      activeDedupes.delete(dk);
      activeDedupeKeys.delete(dk);
    }
  }

  async function runOnce(
    args: TArgs,
    opts: DispatchOptions<TArgs, TResult>,
    ac: AbortController,
    id: string,
    dedupeEntry: DedupeSlot | null,
    dedupeKey: string | null,
    dispatchedAt: number,
  ): Promise<TResult | null> {
    started.add(id);
    if (!inFlight.has(id) && ac.signal.aborted) {
      started.delete(id);
      return null;
    }
    const settle = (): void => {
      inFlight.delete(id);
      started.delete(id);
      if (opts.onSettled) {
        safeInvoke(def.name, "onSettled", () => {
          opts.onSettled!(args);
        });
      }
    };

    if (ac.signal.aborted) {
      const now = Date.now();
      if (dedupeEntry !== null) {
        dedupeEntry.cancelled = true;
      }
      evictDedupeSlot(dedupeKey, dedupeEntry);
      record({
        id,
        name: def.name,
        status: "cancelled",
        args,
        dispatchedAt,
        startedAt: now,
        completedAt: now,
      });
      settle();
      return null;
    }

    const startedAt = Date.now();

    const idemKey =
      typeof def.idempotencyKey === "function"
        ? def.idempotencyKey(args)
        : def.idempotencyKey === true
          ? generateIdempotencyKey()
          : null;
    const ctx: ActionContext =
      idemKey !== null ? { instanceID: id, idempotencyKey: idemKey } : { instanceID: id };

    let optOp: TOp | undefined;
    if (def.optimistic !== undefined) {
      try {
        optOp = def.optimistic(args);
      } catch (e) {
        const raw = toActionError(e);
        const err: ActionErrorLike =
          raw.code !== undefined ? raw : { ...raw, code: "optimistic_failed" };
        if (dedupeEntry !== null) {
          dedupeEntry.error = err;
        }
        evictDedupeSlot(dedupeKey, dedupeEntry);
        record({
          id,
          name: def.name,
          status: "error",
          args,
          dispatchedAt,
          startedAt,
          completedAt: Date.now(),
          error: err,
        });
        emitErrorToast(args, err);
        if (opts.onError) {
          safeInvoke(def.name, "onError", () => {
            opts.onError!(err, args);
          });
        }
        settle();
        return null;
      }
    }

    record({
      id,
      name: def.name,
      status: "pending",
      args,
      dispatchedAt,
      startedAt,
    });

    try {
      const { result, attempts } = await runWithRetry(args, ac.signal, ctx);
      if (ac.signal.aborted) {
        if (dedupeEntry !== null) {
          dedupeEntry.cancelled = true;
        }
        evictDedupeSlot(dedupeKey, dedupeEntry);
        record({
          id,
          name: def.name,
          status: "cancelled",
          args,
          dispatchedAt,
          startedAt,
          completedAt: Date.now(),
          attempts,
        });
        if (def.rollback !== undefined) {
          try {
            def.rollback(args, optOp, { message: "cancelled", code: "cancelled" });
          } catch (e) {
            console.error(`[actions] rollback (cancellation) for ${def.name} threw`, e);
          }
        }
        return null;
      }
      record({
        id,
        name: def.name,
        status: "success",
        args,
        dispatchedAt,
        startedAt,
        completedAt: Date.now(),
        result,
        attempts,
      });
      evictDedupeSlot(dedupeKey, dedupeEntry);
      emitSuccessToast(args, result, opts);
      if (opts.onSuccess) {
        safeInvoke(def.name, "onSuccess", () => {
          opts.onSuccess!(result, args);
        });
      }
      return result;
    } catch (e: unknown) {
      const err = toActionError(e);
      const attempts = readAttempts(e);
      const cancelled = ac.signal.aborted;
      const status = cancelled ? "cancelled" : "error";
      if (dedupeEntry !== null) {
        if (cancelled) {
          dedupeEntry.cancelled = true;
        } else {
          dedupeEntry.error = err;
        }
      }
      evictDedupeSlot(dedupeKey, dedupeEntry);
      record({
        id,
        name: def.name,
        status,
        args,
        dispatchedAt,
        startedAt,
        completedAt: Date.now(),
        ...(!cancelled && { error: err }),
        ...(attempts !== undefined && { attempts }),
      });
      if (def.rollback !== undefined) {
        try {
          const rbError = cancelled ? { message: "cancelled", code: "cancelled" } : err;
          def.rollback(args, optOp, rbError);
        } catch (rbCaught) {
          console.error(`[actions] rollback for ${def.name} threw`, rbCaught);
        }
      }
      if (!cancelled) {
        emitErrorToast(args, err);
        if (opts.onError) {
          safeInvoke(def.name, "onError", () => {
            opts.onError!(err, args);
          });
        }
      }
      return null;
    } finally {
      settle();
    }
  }

  async function runWithRetry(
    args: TArgs,
    signal: AbortSignal,
    ctx: ActionContext,
  ): Promise<{ result: TResult; attempts: number }> {
    const cfg = def.retry;
    const maxAttempts = (cfg?.count ?? 0) + 1;
    const baseDelay = cfg?.delay;
    const factor = cfg?.factor ?? 2;
    const networkMode = def.networkMode ?? "online";
    let attempt = 0;
    while (true) {
      if (signal.aborted) {
        const abortErr = new DOMException("aborted", "AbortError");
        attachAttempts(abortErr, attempt);
        throw abortErr;
      }
      try {
        attempt++;
        const result = await def.run(args, signal, ctx);
        return { result, attempts: attempt };
      } catch (e) {
        if (signal.aborted) {
          attachAttempts(e, attempt);
          throw e;
        }
        if (attempt >= maxAttempts) {
          attachAttempts(e, attempt);
          throw e;
        }
        const err = toActionError(e);
        if (!shouldRetry(err)) {
          attachAttempts(e, attempt);
          throw e;
        }

        if (networkMode === "online") {
          try {
            await waitForOnline(signal);
          } catch {
            const abortErr = new DOMException("aborted", "AbortError");
            attachAttempts(abortErr, attempt);
            throw abortErr;
          }
        }

        let delayMs: number;
        if (typeof baseDelay === "function") {
          try {
            delayMs = baseDelay(attempt, err);
          } catch {
            delayMs = 0;
          }
        } else if (typeof baseDelay === "number") {
          delayMs = Math.min(baseDelay * Math.pow(factor, attempt - 1), 5000);
        } else {
          delayMs = 0;
        }

        try {
          await sleep(delayMs, signal);
        } catch {
          const abortErr = new DOMException("aborted", "AbortError");
          attachAttempts(abortErr, attempt);
          throw abortErr;
        }
      }
    }
  }

  function shouldRetry(err: ActionErrorLike): boolean {
    if (def.retryable === undefined) {
      return false;
    }
    try {
      return def.retryable(err);
    } catch {
      return false;
    }
  }

  function emitSuccessToast(
    args: TArgs,
    result: TResult,
    opts: DispatchOptions<TArgs, TResult>,
  ): void {
    if (opts.silent === true) {
      return;
    }
    try {
      const msg = resolveToast(def.success, args, result);
      if (msg !== null) {
        notifySuccess(msg);
      }
    } catch (e) {
      console.error(`[actions] emitSuccessToast for ${def.name} threw`, e);
    }
  }

  function emitErrorToast(args: TArgs, err: ActionErrorLike): void {
    const spec = def.error;
    if (spec === false) {
      return;
    }
    const fallbackMsg = `${defaultErrorPrefix(def.name)}: ${err.message}`;
    const retry = buildRetryButton(args, err);
    try {
      let msg: string;
      if (typeof spec === "string") {
        msg = `${spec}: ${err.message}`;
      } else if (typeof spec === "function") {
        msg = spec(args, err);
      } else {
        msg = fallbackMsg;
      }
      notifyError(msg, retry);
    } catch (e) {
      console.error(`[actions] emitErrorToast for ${def.name} threw`, e);
      notifyError(fallbackMsg, retry);
    }
  }

  function buildRetryButton(
    args: TArgs,
    err: ActionErrorLike,
  ): { onClick: () => void } | undefined {
    if (!shouldRetry(err)) {
      return undefined;
    }
    let frozenArgs: TArgs;
    try {
      frozenArgs = structuredClone(args);
    } catch {
      if (args === null || args === undefined || typeof args !== "object") {
        frozenArgs = args;
      } else {
        try {
          frozenArgs = (Array.isArray(args) ? [...args] : { ...args }) as TArgs;
        } catch {
          frozenArgs = args;
        }
      }
    }
    return {
      onClick: () => {
        void dispatch(frozenArgs);
      },
    };
  }

  function cancel(): void {
    if (inFlight.size === 0) {
      return;
    }
    for (const dk of activeDedupeKeys) {
      const entry = activeDedupes.get(dk);
      if (entry !== undefined) {
        entry.cancelled = true;
      }
      activeDedupes.delete(dk);
    }
    activeDedupeKeys.clear();
    for (const [id, controller] of [...inFlight.entries()]) {
      controller.abort();
      if (!started.has(id)) {
        inFlight.delete(id);
        const skip = scopeSkipResolvers.get(id);
        if (skip !== undefined) {
          const prev = scopePrevs.get(id);
          scopeSkipResolvers.delete(id);
          scopePrevs.delete(id);
          if (prev !== undefined) {
            void prev.then(skip, skip);
          } else {
            skip();
          }
        }
        const earlyCancel = scopeCancelResolvers.get(id);
        if (earlyCancel !== undefined) {
          scopeCancelResolvers.delete(id);
          earlyCancel();
        }
      }
    }
  }

  const action: Action<TArgs, TResult> = {
    name: def.name,
    dispatch,
    cancel,
  };

  _registerAction(action);

  return action;
}

/** Test-only: reset the instance counter + scope chains + dedupe map. */
export function _resetForTest(): void {
  instanceCounter = 0;
  _resetSymbols();
  scopeChains.clear();
  activeDedupes.clear();
}

/** Test-only: expose internal map sizes for leak verification. */
export function _internalsForTest(): { scopeChains: number; activeDedupes: number } {
  return { scopeChains: scopeChains.size, activeDedupes: activeDedupes.size };
}
