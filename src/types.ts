// Action framework types: defines the contract between callers, the
// dispatcher, and observers. Pure types — no imports, no runtime
// behavior — so any module in the codebase can depend on this without
// pulling in transport / toast / store.
// ---------------------------------------------------------------------------

/** Lifecycle status of a single dispatched action instance. */
export type ActionLifecycleStatus =
  | "pending"
  | "success"
  | "error"
  | "cancelled";

/** Errors thrown by an action's run() function. */
export interface ActionErrorLike {
  readonly message: string;
  readonly status?: number;
  readonly code?: string;
  readonly cause?: unknown;
}

/** Snapshot of a single in-flight or historical action invocation. */
export interface ActionInstance<TArgs = unknown, TResult = unknown> {
  readonly id: string;
  readonly name: string;
  readonly status: ActionLifecycleStatus;
  readonly args: TArgs;
  readonly dispatchedAt: number;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly result?: TResult;
  readonly error?: ActionErrorLike;
  readonly attempts?: number;
}

/** Toast wiring: either a literal string, a function, or false to suppress. */
export type ToastSpec<TArgs, TPayload> =
  | string
  | ((args: TArgs, payload: TPayload) => string)
  | false;

/** Per-dispatch context passed to run() as the 3rd argument. */
export interface ActionContext {
  readonly instanceID: string;
  readonly idempotencyKey?: string;
}

/** Configuration for automatic retry of transient failures. */
export interface RetryConfig {
  readonly count: number;
  readonly delay: number | ((attempt: number, err: ActionErrorLike) => number);
  readonly factor?: number;
}

/** Standard retry config: 2 retries, 300ms initial delay. */
export const RETRY_STANDARD: RetryConfig = { count: 2, delay: 300 } as const;

export interface ActionDefinition<TArgs, TResult, TOp = unknown> {
  readonly name: string;
  run: (args: TArgs, signal: AbortSignal, ctx?: ActionContext) => Promise<TResult>;
  optimistic?: (args: TArgs) => TOp | undefined;
  rollback?: (args: TArgs, op: TOp | undefined, err: ActionErrorLike) => void;
  success?: ToastSpec<TArgs, TResult>;
  error?: ToastSpec<TArgs, ActionErrorLike>;
  retryable?: (err: ActionErrorLike) => boolean;
  retry?: RetryConfig;
  networkMode?: "online" | "always";
  scope?: string | ((args: TArgs) => string);
  idempotencyKey?: boolean | ((args: TArgs) => string);
  dedupe?: boolean | ((args: TArgs) => string);
}

/** A registered action, returned by defineAction(). */
export interface Action<TArgs, TResult> {
  readonly name: string;
  dispatch(args: TArgs, opts?: DispatchOptions<TArgs, TResult>): Promise<TResult | null>;
  cancel(): void;
}

/** Per-dispatch overrides. */
export interface DispatchOptions<TArgs = unknown, TResult = unknown> {
  readonly silent?: boolean;
  readonly onSuccess?: (result: TResult, args: TArgs) => void;
  readonly onError?: (err: ActionErrorLike, args: TArgs) => void;
  readonly onSettled?: (args: TArgs) => void;
}

/** HTTP request descriptor used by apiAction(). */
export type RequestSpec =
  | { readonly method: "GET"; readonly path: string }
  | {
      readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
      readonly path: string;
      readonly body?: unknown;
    };

/** Subscriber callback for the registry. */
export type RegistryListener = (instance: ActionInstance) => void;
