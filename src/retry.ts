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

/** Wait for the browser to come back online, or for the signal to abort. */
export function waitForOnline(signal: AbortSignal): Promise<void> {
  if (typeof navigator === "undefined" || navigator.onLine) {
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
