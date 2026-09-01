// Unlike pollAction, no pauseWhenHidden/refreshOnFocus: this is a bounded
// flow the caller drives to completion, not a background refresh.

export interface PollUntilOptions<T> {
  readonly intervalMs: number;
  /** Returns true on a result that ends the poll. */
  readonly until: (result: T) => boolean;
  /** 0/undefined = unlimited. */
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  /** Applied to the wait after consecutive transient failures (null result or throw). */
  readonly backoff?: { readonly factor: number; readonly maxMs: number };
  /** Fires for a non-terminal successful poll. */
  readonly onPoll?: (result: T) => void;
  /** Fires on a transient failure (step returned null or threw). */
  readonly onTransientError?: () => void;
  /** A pre-aborted signal resolves `aborted` without calling `step`. */
  readonly signal?: AbortSignal;
}

export type PollUntilOutcome<T> =
  | { readonly status: "done"; readonly result: T }
  | { readonly status: "timeout" }
  | { readonly status: "aborted" };

/** Resolves early (never rejects) if `signal` fires; caller re-checks `signal.aborted`. */
function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const ac = new AbortController();
    const t = setTimeout(() => {
      ac.abort();
      resolve();
    }, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        ac.abort();
        resolve();
      },
      { signal: ac.signal },
    );
  });
}

/** A null result or a throw is a transient failure (backs off if `backoff` is set). */
export async function pollUntil<T>(
  step: (signal: AbortSignal) => Promise<T | null>,
  opts: PollUntilOptions<T>,
): Promise<PollUntilOutcome<T>> {
  const { intervalMs, until, maxAttempts, timeoutMs, backoff, onPoll, onTransientError } = opts;
  const signal = opts.signal ?? new AbortController().signal;

  if (signal.aborted) {
    return { status: "aborted" };
  }

  const start = Date.now();
  let attempts = 0;
  let failures = 0;

  for (;;) {
    const delay =
      backoff !== undefined && failures > 0
        ? Math.min(intervalMs * Math.pow(backoff.factor, failures), backoff.maxMs)
        : intervalMs;
    await sleepWithSignal(delay, signal);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- aborted flips during the awaited sleep
    if (signal.aborted) {
      return { status: "aborted" };
    }
    attempts += 1;
    if (maxAttempts !== undefined && maxAttempts > 0 && attempts > maxAttempts) {
      return { status: "timeout" };
    }
    if (timeoutMs !== undefined && Date.now() - start >= timeoutMs) {
      return { status: "timeout" };
    }

    let result: T | null;
    try {
      result = await step(signal);
    } catch {
      result = null;
    }

    // Abort that fired during step() wins over treating the (likely null)
    // result as a transient failure — no spurious onTransientError on teardown.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- aborted flips during the awaited step
    if (signal.aborted) {
      return { status: "aborted" };
    }

    if (result === null) {
      if (onTransientError !== undefined) {
        try {
          onTransientError();
        } catch (e) {
          console.error("[pollUntil] onTransientError threw", e);
        }
      }
      failures += 1;
      continue;
    }

    failures = 0;
    if (until(result)) {
      return { status: "done", result };
    }
    if (onPoll !== undefined) {
      try {
        onPoll(result);
      } catch (e) {
        console.error("[pollUntil] onPoll threw", e);
      }
    }
  }
}
