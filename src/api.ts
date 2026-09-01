// actions holds its own @cplieger/fetch instance (fetch v2 is
// instances-only), fully isolated from any instance a consuming app builds,
// and maps fetch's ApiResult envelope onto ActionError.

import { API_TIMEOUT_MS, createFetch } from "@cplieger/fetch";
import type { ApiErr, FetchConfig, FetchInstance, RequestOptions } from "@cplieger/fetch";

import { defineAction, IDEMPOTENCY_HEADER } from "./define.js";
import { ActionError } from "./error.js";
import type {
  Action,
  ActionContext,
  ActionDefinition,
  ActionErrorLike,
  RequestSpec,
} from "./types.js";

const JSON_CT = "application/json";

/** Configuration for the global API fetch layer (mirrors RTK's
 *  fetchBaseQuery). Set via `configureApi()`. */
export interface ApiConfig {
  /** Base URL prepended to every RequestSpec.path (e.g. "https://api.example.com/v1").
   *  `RequestSpec.path` is treated as a RELATIVE path: when this is set, an absolute or
   *  protocol-relative path cannot override the origin (it is kept as a path segment).
   *  When this is UNSET, `RequestSpec.path` is passed to fetch() verbatim, so the caller
   *  owns the full URL and must never pass untrusted input as the whole path. */
  readonly baseUrl?: string;
  /** Inject headers on every request. Receives current headers + the request spec.
   *  Mutate and/or return the headers object. May be async (e.g. to read a token store). */
  readonly prepareHeaders?: (
    headers: Headers,
    context: { spec: RequestSpec },
  ) => Headers | undefined | Promise<Headers | undefined>;
  /** RequestInit.credentials mode applied to every request (e.g. "include" for cookies). */
  readonly credentials?: RequestCredentials;
  /** Custom fetch implementation. Useful for SSR (isomorphic-fetch) or testing. */
  readonly fetchFn?: typeof fetch;
}

// fetch v2's config is frozen at construction, so configureApi's
// replace-not-merge semantics rebuild the instance rather than mutate it.
// prepareHeaders stays here rather than on the instance: it is spec-aware
// (`(headers, { spec })`), a shape fetch's `(headers)`-only hook can't express.
let apiFetch: FetchInstance = createFetch();
let apiPrepareHeaders: ApiConfig["prepareHeaders"];

/**
 * Configure the global HTTP layer used by all `apiAction` instances.
 * Call once at app boot. Subsequent calls replace the previous config.
 *
 * @example
 * ```ts
 * configureApi({
 *   baseUrl: "https://api.example.com",
 *   credentials: "include",
 *   prepareHeaders: (headers) => {
 *     headers.set("Authorization", `Bearer ${getToken()}`);
 *   },
 * });
 * ```
 */
export function configureApi(config: ApiConfig): void {
  const fetchConfig: FetchConfig = {};
  if (config.baseUrl !== undefined) {
    fetchConfig.baseUrl = config.baseUrl;
  }
  if (config.credentials !== undefined) {
    fetchConfig.credentials = config.credentials;
  }
  if (config.fetchFn !== undefined) {
    fetchConfig.fetchFn = config.fetchFn;
  }
  // fetch v2 instances are immutable; replace-not-merge needs a fresh one.
  apiFetch = createFetch(fetchConfig);
  apiPrepareHeaders = config.prepareHeaders;
}

/** Reset API config. @internal Test-only. */
export function _resetApiConfigForTest(): void {
  apiFetch = createFetch();
  apiPrepareHeaders = undefined;
}

/** Context passed to the {@link ApiActionDefinition.decode} hook. */
export interface ApiDecodeContext {
  /** HTTP status of the 2xx response being decoded. */
  readonly status: number;
  /** The request descriptor this response answers. */
  readonly spec: RequestSpec;
}

/** A failed request as seen by {@link ApiActionDefinition.decodeError}: the
 *  real HTTP response's status, the message the fetch layer lifted, the
 *  server-supplied code (when present), the parsed JSON body (when one
 *  parsed), and the response headers. Transport-level failures (network /
 *  timeout / cancellation / invalid — status 0) never reach the hook. */
export interface ApiErrorInfo {
  readonly status: number;
  readonly message: string;
  readonly code?: string;
  /** Parsed JSON body of the failed response. Server-controlled input —
   *  validate the shape before reading fields. */
  readonly body?: unknown;
  readonly headers?: Headers;
}

/** Return shape of {@link ApiActionDefinition.decodeError}: resolve the
 *  dispatch as a success carrying `value`, or replace the default error. */
export type ApiErrorDecision<TResult> =
  | { readonly kind: "success"; readonly value: TResult }
  | { readonly kind: "error"; readonly error: ActionErrorLike };

/** Caller-facing shape of an apiAction definition. Replaces `run` with
 *  a `request` function that returns an HTTP {@link RequestSpec}. */
export interface ApiActionDefinition<TArgs, TResult, TOp = unknown> extends Omit<
  ActionDefinition<TArgs, TResult, TOp>,
  "run"
> {
  request: (args: TArgs) => RequestSpec;

  /** Decode / validate a 2xx response body. Receives the raw decoded body
   *  (`undefined` for a 204 / empty-body response) and returns the action
   *  result; throw (an {@link ActionError}) to route the dispatch to the
   *  error branch instead (rollback + error notification + registry error) —
   *  the seam for 200-with-error envelopes. Absent: the body is returned as
   *  `TResult` unchanged. */
  decode?: (data: unknown, ctx: ApiDecodeContext) => TResult;

  /** Reinterpret a failed request that produced a real HTTP response. Return
   *  `{ kind: "success", value }` to resolve the dispatch as success (e.g. a
   *  409 whose body is a meaningful payload), `{ kind: "error", error }` to
   *  replace the default error, or `undefined` to keep the default
   *  {@link ActionError} mapping. Transport failures (status 0: network /
   *  timeout / cancelled / invalid) never reach this hook, so retry
   *  classification and cancellation semantics are preserved. */
  decodeError?: (
    info: ApiErrorInfo,
    ctx: { readonly spec: RequestSpec },
  ) => ApiErrorDecision<TResult> | undefined;
}

/**
 * Build an Action from an HTTP request descriptor.
 * Wraps `defineAction` with a generated `run()` that dispatches the
 * {@link RequestSpec} through the {@link ApiConfig} layer configured with
 * {@link configureApi} (backed by an isolated `@cplieger/fetch` instance).
 */
export function apiAction<TArgs, TResult = unknown, TOp = unknown>(
  def: ApiActionDefinition<TArgs, TResult, TOp>,
): Action<TArgs, TResult> {
  const { request, decode, decodeError, ...rest } = def;
  return defineAction<TArgs, TResult, TOp>({
    ...rest,
    run: async (args, signal, ctx) => {
      const spec = request(args);
      return executeRequest<TResult>(spec, signal, ctx, decode, decodeError);
    },
  });
}

async function executeRequest<T>(
  spec: RequestSpec,
  signal: AbortSignal,
  ctx?: ActionContext,
  decode?: (data: unknown, dctx: ApiDecodeContext) => T,
  decodeError?: (
    info: ApiErrorInfo,
    dctx: { readonly spec: RequestSpec },
  ) => ApiErrorDecision<T> | undefined,
): Promise<T> {
  // Content-Type is set before prepareHeaders so the hook can see/override it.
  const headers = new Headers();
  if (spec.method !== "GET" && spec.body !== undefined) {
    headers.set("Content-Type", JSON_CT);
  }
  if (ctx?.idempotencyKey !== undefined) {
    headers.set(IDEMPOTENCY_HEADER, ctx.idempotencyKey);
  }
  if (spec.headers !== undefined) {
    for (const [k, v] of Object.entries(spec.headers)) {
      headers.set(k, v);
    }
  }
  // A returned Headers wins (RTK convention); a throw here propagates before
  // fetch is ever called.
  let effectiveHeaders = headers;
  if (apiPrepareHeaders !== undefined) {
    const prepared = await apiPrepareHeaders(headers, { spec });
    if (prepared !== undefined) {
      effectiveHeaders = prepared;
    }
  }

  const opts: RequestOptions<T> = {
    signal,
    timeoutMs: API_TIMEOUT_MS,
    headers: effectiveHeaders,
  };
  if (spec.method !== "GET") {
    if (spec.rawBody !== undefined) {
      // Sent as-is: no JSON encoding, no automatic Content-Type.
      opts.rawBody = spec.rawBody;
    } else if (spec.body !== undefined) {
      opts.body = spec.body;
    }
  }

  const result = await apiFetch.requestRaw<T>(spec.method, spec.path, opts);
  if (result.ok) {
    if (decode !== undefined) {
      // A decode throw routes the dispatch to the error branch — the seam
      // for 200-with-error envelopes.
      return decode(result.data, { status: result.status, spec });
    }
    // fetch collapses a 204 and an empty-body 2xx to data === undefined.
    if (result.data === undefined && result.status !== 204 && spec.method !== "DELETE") {
      console.warn(
        `[actions] ${spec.method} ${spec.path} returned empty body — callers expecting data will receive undefined`,
      );
    }
    return result.data;
  }
  // Transport failures (status 0) never reach decodeError, so retryNetwork
  // classification and cancellation semantics can't be rewritten by the hook.
  if (decodeError !== undefined && result.status > 0) {
    const decision = decodeError(
      {
        status: result.status,
        message: result.error,
        ...(result.code !== undefined && { code: result.code }),
        ...(result.body !== undefined && { body: result.body }),
        ...(result.headers !== undefined && { headers: result.headers }),
      },
      { spec },
    );
    if (decision !== undefined) {
      if (decision.kind === "success") {
        return decision.value;
      }
      const e = decision.error;
      throw e instanceof ActionError
        ? e
        : new ActionError(e.message, {
            ...(e.status !== undefined && { status: e.status }),
            ...(e.code !== undefined && { code: e.code }),
            ...(e.cause !== undefined && { cause: e.cause }),
          });
    }
  }
  throw actionErrorFromApiErr(result);
}

/**
 * Map a fetch {@link ApiErr} envelope onto an {@link ActionError}. A `status`
 * of 0 marks a transport failure (`code: network | timeout | cancelled |
 * invalid`); any other status is a real HTTP response.
 */
function actionErrorFromApiErr(err: ApiErr): ActionError {
  const { status, error, code } = err;
  if (status === 0) {
    if (code === "cancelled") {
      return new ActionError("Request cancelled", { code: "cancelled" });
    }
    if (code === "timeout") {
      return new ActionError("Request timed out", { status: 0, code: "timeout" });
    }
    if (code === "invalid") {
      // No HTTP status: retryNetwork treats a status-less error as non-retryable.
      return new ActionError(error, { code: "invalid" });
    }
    return new ActionError(error, { status: 0, code: "network" });
  }
  const opts: { status: number; code?: string } = { status };
  if (code !== undefined) {
    opts.code = code;
  }
  return new ActionError(error, opts);
}
