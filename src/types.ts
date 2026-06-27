// Action framework types: defines the contract between callers, the
// dispatcher, and observers. Pure types — no imports, no runtime
// behavior — so any module in the codebase can depend on this without
// pulling in transport / notification / store.
// ---------------------------------------------------------------------------

/** Lifecycle status of a single dispatched action instance.
 *
 *  - `"pending"` — optimistic ran (if any), run() in flight
 *  - `"success"` — run() resolved
 *  - `"error"` — run() threw; rollback ran
 *  - `"cancelled"` — action.cancel() called or signal aborted externally */
export type ActionLifecycleStatus = "pending" | "success" | "error" | "cancelled";

/** Errors thrown by an action's run() function. ActionError subclass
 *  in error.ts attaches HTTP status + server error code metadata. */
export interface ActionErrorLike {
  readonly message: string;
  /** HTTP status if applicable. */
  readonly status?: number;
  /** Server-side error code. */
  readonly code?: string;
  readonly cause?: unknown;
}

/** Snapshot of a single in-flight or historical action invocation.
 *  Stored in the registry log for observability. */
export interface ActionInstance<TArgs = unknown, TResult = unknown> {
  /** Unique per dispatch. */
  readonly id: string;
  /** Matches ActionDefinition.name. */
  readonly name: string;
  readonly status: ActionLifecycleStatus;
  readonly args: TArgs;
  /** Date.now() when dispatch() was called. */
  readonly dispatchedAt: number;
  /** Date.now() when run() begins (after scope queue). */
  readonly startedAt: number;
  /** Date.now() at terminal state. */
  readonly completedAt?: number;
  /** Present iff status === "success". */
  readonly result?: TResult;
  /** Present iff status === "error". */
  readonly error?: ActionErrorLike;
  /** Total run() invocations (1 = no retry; >1 = retries fired). */
  readonly attempts?: number;
}

/** Notification wiring: either a literal string (used as-is), or a function
 *  computed from action args + result/error at call time. Pass false
 *  to opt out of the default notification for that branch. */
export type NotificationSpec<TArgs, TPayload> =
  | string
  | ((args: TArgs, payload: TPayload) => string)
  | false;

/** @deprecated Use {@link NotificationSpec} instead. */
export type ToastSpec<TArgs, TPayload> = NotificationSpec<TArgs, TPayload>;

/** Per-dispatch context passed to run() as the 3rd argument. Mostly
 *  populated by the framework so adapters (apiAction, transportAction)
 *  can read out values like the idempotency key without the caller
 *  having to plumb them. */
export interface ActionContext {
  /** Stable identifier for this dispatch (matches the registry's
   *  ActionInstance.id). */
  readonly instanceID: string;
  /** Set when ActionDefinition.idempotencyKey is configured. The
   *  framework generates this once per dispatch (not per retry). */
  readonly idempotencyKey?: string;
}

/** Configuration for automatic retry of transient failures. */
export interface RetryConfig {
  /** Additional attempts beyond the first (e.g. 2 = up to 3 total). */
  readonly count: number;
  /** Milliseconds before each retry. Number form: exponential backoff via
   *  `delay × factor^(attempt-1)`, capped at 5s. Function form: full
   *  control — receives the attempt number and the triggering error. */
  readonly delay: number | ((attempt: number, err: ActionErrorLike) => number);
  /** Backoff multiplier per retry. Default 2. Ignored when `delay` is a function. */
  readonly factor?: number;
}

/** Standard retry config: 2 retries, 300ms initial delay. */
export const RETRY_STANDARD: RetryConfig = { count: 2, delay: 300 } as const;

export interface ActionDefinition<TArgs, TResult, TOp = unknown> {
  /** Stable identifier, e.g. "chat.delete", "files.create".
   *  Used in the registry log + as a default notification prefix. */
  readonly name: string;

  /** The work the action performs. Must throw ActionError on failure
   *  (or any Error — wrappers will normalise). */
  run: (args: TArgs, signal: AbortSignal, ctx?: ActionContext) => Promise<TResult>;

  /** Optional optimistic mutation. Runs synchronously before run(). */
  optimistic?: (args: TArgs) => TOp | undefined;

  /** Undo the optimistic mutation. Called on error OR cancellation (including a
   *  cancellation that lands after run() resolves), never on success. The `err`
   *  carries {code:'cancelled'} on the cancellation path. */
  rollback?: (args: TArgs, op: TOp | undefined, err: ActionErrorLike) => void;

  /** Notification on success. Default: no notification. */
  success?: NotificationSpec<TArgs, TResult>;

  /** Notification on error. Default: action name humanised + error message. */
  error?: NotificationSpec<TArgs, ActionErrorLike>;

  /** Definition-level success callback. Fires on every successful dispatch.
   *  Mirrors TanStack Query's mutation-level onSuccess. */
  onSuccess?: (result: TResult, args: TArgs) => void;

  /** Definition-level error callback. Fires on every failed dispatch.
   *  Mirrors TanStack Query's mutation-level onError. */
  onError?: (err: ActionErrorLike, args: TArgs) => void;

  /** Definition-level settled callback. Fires after every dispatch
   *  (success, error, or cancellation). Mirrors TanStack Query's onSettled. */
  onSettled?: (args: TArgs) => void;

  /** Classify whether an error qualifies for retry. */
  retryable?: (err: ActionErrorLike) => boolean;

  /** Auto-retry transient failures before surfacing the error notification. */
  retry?: RetryConfig;

  /** Auto-retry behavior when offline. Default `"online"`. */
  networkMode?: "online" | "always";

  /** Timeout in milliseconds for the run() function. Uses AbortSignal.timeout()
   *  composed with the cancellation signal. If run() exceeds this duration,
   *  the signal aborts with a TimeoutError. */
  timeout?: number;

  /** Serialize concurrent dispatches sharing the same scope key. */
  scope?: string | ((args: TArgs) => string);

  /** Generate an idempotency key per dispatch. */
  idempotencyKey?: boolean | ((args: TArgs) => string);

  /** Collapse concurrent dispatches with matching key into one in-flight promise. */
  dedupe?: boolean | ((args: TArgs) => string);
}

/** A registered action, returned by defineAction(). Can be dispatched
 *  many times; each dispatch is a separate instance with its own
 *  cancellation token. */
export interface Action<TArgs, TResult> {
  readonly name: string;

  /** Run the action. Returns a DispatchHandle with the result promise
   *  and a per-dispatch abort() method (RTK pattern). */
  dispatch(args: TArgs, opts?: DispatchOptions<TArgs, TResult>): DispatchHandle<TResult>;

  /** Cancel all in-flight instances. Each instance moves to status
   *  "cancelled" and run()'s signal aborts. */
  cancel(): void;
}

/** Handle returned by dispatch(). An augmented Promise with an abort()
 *  method for per-dispatch cancellation (mirrors RTK createAsyncThunk).
 *  Can be awaited directly as a Promise. */
export interface DispatchHandle<TResult> extends Promise<TResult | null> {
  /** Abort this specific dispatch. Other in-flight dispatches of the
   *  same action are unaffected. Mirrors RTK's promise.abort(). */
  abort(): void;
}

/** Per-dispatch overrides. */
export interface DispatchOptions<TArgs = unknown, TResult = unknown> {
  /** Suppress the success notification for this call. Errors still notify. */
  readonly silent?: boolean;
  /** Per-call success callback. Fires after the action-level notification. */
  readonly onSuccess?: (result: TResult, args: TArgs) => void;
  /** Per-call error callback. Fires after the action-level error notification. */
  readonly onError?: (err: ActionErrorLike, args: TArgs) => void;
  /** Per-call settled callback. Fires for success, error, AND cancellation. */
  readonly onSettled?: (args: TArgs) => void;
}

/** HTTP request descriptor used by apiAction(). GET is included for
 *  read actions that want notification/cancellation semantics. */
export type RequestSpec =
  | {
      readonly method: "GET";
      readonly path: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
      readonly path: string;
      readonly body?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    };

/** Subscriber callback for the registry. Fires once per state
 *  transition (pending -> success/error/cancelled). */
export type RegistryListener = (instance: ActionInstance) => void;
