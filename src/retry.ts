// retry.ts — extracted retry/backoff primitives from define.ts.
// These are pure utility functions with no dependency on the action
// framework, making them independently testable.
// ---------------------------------------------------------------------------

/** Abort-aware sleep. Rejects with AbortError if the signal fires
 *  before the timeout elapses. Resolves immediately for ms <= 0. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("aborted", "AbortError"));
  }
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wait for the browser to come back online, or for the signal to abort.
 *  Resolves immediately unless the platform positively reports being offline. */
export function waitForOnline(signal: AbortSignal): Promise<void> {
  // Only WAIT when the platform positively says offline. An absent `onLine` is not
  // evidence of a disconnection, and reading it off the object rather than testing
  // for the object is what makes that true in every runtime: Node ships a
  // `Navigator` with no `onLine`, so a `typeof navigator` test answers "assume
  // offline" and then registers no `online` listener, because there is no `window`
  // to register it on. The promise could only settle by abort.
  //
  // The nullable type on the read is load-bearing rather than decorative. The DOM
  // lib declares `navigator` always present and `onLine` a plain `boolean`, which
  // is true of a browser and of nothing else; read through that type the compiler
  // proves this check dead and the lint offers to delete the one guard the
  // non-browser runtimes need.
  const onLine = (globalThis as { readonly navigator?: Navigator }).navigator?.onLine;
  if (onLine !== false) {
    return Promise.resolve();
  }
  if (signal.aborted) {
    return Promise.reject(new DOMException("aborted", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const onOnline = (): void => {
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    function cleanup(): void {
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
      }
      signal.removeEventListener("abort", onAbort);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", onOnline, { once: true });
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Attach attempt count to a thrown error (non-enumerable property). */
export function attachAttempts(e: unknown, attempts: number): void {
  if (typeof e === "object" && e !== null) {
    try {
      Object.defineProperty(e, "_attempts", { value: attempts, configurable: true });
    } catch {
      /* frozen/sealed object — skip */
    }
  }
}

/** Read the attempt count attached by runWithRetry, or undefined. */
export function readAttempts(e: unknown): number | undefined {
  try {
    if (typeof e === "object" && e !== null && "_attempts" in e) {
      const val = (e as { readonly _attempts: unknown })._attempts;
      return typeof val === "number" ? val : undefined;
    }
  } catch {
    /* Proxy or getter threw — skip */
  }
  return undefined;
}
