// pollUntil: poll-until-terminal primitive. Sibling to pollAction, but
// time-boxed rather than a forever periodic refresh: it repeatedly calls
// `step` on a wait-then-poll cadence until a terminal predicate matches, a
// max-attempts / wall-clock budget is exhausted, or an AbortSignal fires.
//
// Unlike pollAction it deliberately has NO pauseWhenHidden / refreshOnFocus —
// a device-flow / download-progress poll is a bounded flow the caller drives
// to completion, not a background refresh that should pause while the tab is
// hidden. That distinction is the whole reason pollAction does not fit.
// ---------------------------------------------------------------------------

/** Configuration for {@link pollUntil}. Controls cadence, the terminal
 *  predicate, optional attempt/time budgets, transient-failure backoff, and
 *  cancellation. */
export interface PollUntilOptions<T> {
  /** Quiet window before each poll in ms. */
  readonly intervalMs: number;
  /** Terminal predicate: return true on a result that ends the poll. */
  readonly until: (result: T) => boolean;
  /** Stop after this many poll attempts. 0/undefined = unlimited. */
  readonly maxAttempts?: number;
  /** Overall wall-clock deadline in ms, measured from the call. */
  readonly timeoutMs?: number;
  /** Exponential backoff applied to the wait after consecutive transient
   *  failures (a null result or a throw). Reset on the next good poll. */
  readonly backoff?: { readonly factor: number; readonly maxMs: number };
  /** Called for a non-terminal successful poll (a non-null result that does
   *  not satisfy `until`). */
  readonly onPoll?: (result: T) => void;
  /** Called when a poll is a transient failure (step returned null or threw). */
  readonly onTransientError?: () => void;
  /** Abort the poll early. A pre-aborted signal resolves `aborted` without
   *  ever calling `step`. */
  readonly signal?: AbortSignal;
}

/** Terminal outcome of {@link pollUntil}. */
export type PollUntilOutcome<T> =
  | { readonly status: "done"; readonly result: T }
  | { readonly status: "timeout" }
  | { readonly status: "aborted" };

/** Sleep for `ms`, resolving early (never rejecting) if `signal` fires. The
 *  caller re-checks `signal.aborted` after waking to decide what to do. */
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

/**
 * Repeatedly call `step` on a wait-then-poll cadence until it yields a
 * terminal result, a budget is exhausted, or the signal aborts.
 *
 * Each iteration waits the current delay (abortable), then polls. A null
 * result or a throw is a transient failure — `onTransientError` fires and,
 * when `backoff` is set, the next wait grows. A non-null result resets the
 * backoff; if it satisfies `until` the poll resolves `done`, otherwise
 * `onPoll` fires and polling continues.
 *
 * @example
 * ```ts
 * const outcome = await pollUntil(
 *   (signal) => apiPoll("/api/device", signal),
 *   {
 *     intervalMs: 5000,
 *     until: (r) => r.status !== "pending",
 *     maxAttempts: 60,
 *     backoff: { factor: 2, maxMs: 60_000 },
 *     signal,
 *   },
 * );
 * ```
 */
export async function pollUntil<T>(
  step: (signal: AbortSignal) => Promise<T | null>,
  opts: PollUntilOptions<T>,
): Promise<PollUntilOutcome<T>> {
  const { intervalMs, until, maxAttempts, timeoutMs, backoff, onPoll, onTransientError } = opts;
  const signal = opts.signal ?? new AbortController().signal;

  // (1) Pre-aborted: bail before any wait or step call.
  if (signal.aborted) {
    return { status: "aborted" };
  }

  const start = Date.now();
  let attempts = 0;
  let failures = 0;

  for (;;) {
    // (2) Wait the (possibly backed-off) delay, aborting early on signal.
    const delay =
      backoff !== undefined && failures > 0
        ? Math.min(intervalMs * Math.pow(backoff.factor, failures), backoff.maxMs)
        : intervalMs;
    await sleepWithSignal(delay, signal);

    // (3) Post-wait gates: abort, then attempt / time budgets.
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

    // (4) Poll. A throw or null result is transient: back off and retry.
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
