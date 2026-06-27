// apiAction: factory for HTTP-backed actions. Wraps fetch so the run()
// implementation is just the request descriptor.
// ---------------------------------------------------------------------------

import { defineAction, IDEMPOTENCY_HEADER } from "./define.js";
import { ActionError, classifyFetchError, hasErrorString } from "./error.js";
import type { Action, ActionContext, ActionDefinition, RequestSpec } from "./types.js";

/** Default request timeout in milliseconds. */
export const API_TIMEOUT_MS = 30_000;

/**
 * Compose an optional caller signal with a fresh timeout signal.
 * If the caller provides an existing signal, the result aborts when
 * either the caller signal or the timeout fires — whichever comes first.
 *
 * @param signal - Existing signal to compose with (may be undefined).
 * @param ms - Timeout in milliseconds.
 * @returns A composed AbortSignal.
 */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal !== undefined
    ? AbortSignal.any([signal, AbortSignal.timeout(ms)])
    : AbortSignal.timeout(ms);
}

const JSON_CT = "application/json";

// ---------------------------------------------------------------------------
// HTTP customization seam (mirrors RTK fetchBaseQuery pattern)
// ---------------------------------------------------------------------------

/** Configuration for the global API fetch layer. Set via `configureApi()`. */
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

let _apiConfig: ApiConfig = {};

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
  _apiConfig = config;
}

/** Reset API config. @internal Test-only. */
export function _resetApiConfigForTest(): void {
  _apiConfig = {};
}

// ---------------------------------------------------------------------------

/** Caller-facing shape of an apiAction definition. Replaces `run` with
 *  a `request` function that returns an HTTP {@link RequestSpec}. */
export interface ApiActionDefinition<TArgs, TResult, TOp = unknown> extends Omit<
  ActionDefinition<TArgs, TResult, TOp>,
  "run"
> {
  request: (args: TArgs) => RequestSpec;
}

/**
 * Build an Action from an HTTP request descriptor.
 * Wraps `defineAction` with a generated `run()` that calls `fetch`
 * via the global {@link ApiConfig} layer configured with {@link configureApi}.
 */
export function apiAction<TArgs, TResult = unknown, TOp = unknown>(
  def: ApiActionDefinition<TArgs, TResult, TOp>,
): Action<TArgs, TResult> {
  const { request, ...rest } = def;
  return defineAction<TArgs, TResult, TOp>({
    ...rest,
    run: async (args, signal, ctx) => {
      const spec = request(args);
      return executeRequest<TResult>(spec, signal, ctx);
    },
  });
}

async function executeRequest<T>(
  spec: RequestSpec,
  signal: AbortSignal,
  ctx?: ActionContext,
): Promise<T> {
  const cfg = _apiConfig;
  const init: RequestInit = { method: spec.method };

  // Build headers via Headers API for prepareHeaders compatibility
  const headers = new Headers();
  if (spec.method !== "GET" && spec.body !== undefined) {
    headers.set("Content-Type", JSON_CT);
    init.body = JSON.stringify(spec.body);
  }
  if (ctx?.idempotencyKey !== undefined) {
    headers.set(IDEMPOTENCY_HEADER, ctx.idempotencyKey);
  }
  // Per-request headers from RequestSpec
  if (spec.headers !== undefined) {
    for (const [k, v] of Object.entries(spec.headers)) {
      headers.set(k, v);
    }
  }
  // Global prepareHeaders hook. Honor a returned Headers (RTK convention), falling
  // back to the mutated instance when the hook returns undefined.
  let effectiveHeaders = headers;
  if (cfg.prepareHeaders !== undefined) {
    const prepared = await cfg.prepareHeaders(headers, { spec });
    if (prepared !== undefined) {
      effectiveHeaders = prepared;
    }
  }
  // Convert Headers to plain object for RequestInit
  const headerObj: Record<string, string> = {};
  effectiveHeaders.forEach((v, k) => {
    headerObj[k.toLowerCase()] = v;
  });
  if (Object.keys(headerObj).length > 0) {
    init.headers = headerObj;
  }

  // Credentials
  if (cfg.credentials !== undefined) {
    init.credentials = cfg.credentials;
  }

  init.signal = withTimeout(signal, API_TIMEOUT_MS);

  // CONTRACT: spec.path is a RELATIVE path. With baseUrl set, the base scheme+host
  // precede it, so an absolute ('https://...') or protocol-relative ('//host') path is
  // neutralised (kept as a path segment) and cannot override the origin. With baseUrl
  // UNSET, spec.path is passed to fetch() verbatim, so the caller owns the full URL and
  // must never pass untrusted input (e.g. a server-supplied string) as the whole path.
  // Resolve URL: prepend baseUrl if configured, normalizing double slashes at the join
  let url: string;
  if (cfg.baseUrl !== undefined) {
    const base = cfg.baseUrl.endsWith("/") ? cfg.baseUrl.slice(0, -1) : cfg.baseUrl;
    const path = spec.path.startsWith("/") ? spec.path : `/${spec.path}`;
    url = `${base}${path}`;
  } else {
    url = spec.path;
  }

  // Use custom fetchFn or global fetch
  const fetchImpl = cfg.fetchFn ?? fetch;

  let r: Response;
  try {
    r = await fetchImpl(url, init);
  } catch (e) {
    throw classifyFetchError(e, signal);
  }
  if (!r.ok) {
    let serverError = "";
    let serverCode: string | undefined;
    try {
      const body: unknown = await r.json();
      if (hasErrorString(body)) {
        serverError = body.error;
      }
      if (typeof body === "object" && body !== null && "code" in body) {
        const code = (body as Record<"code", unknown>).code;
        if (typeof code === "string") {
          serverCode = code;
        }
      }
    } catch {
      // Body wasn't JSON — leave serverError empty.
    }
    const opts: { status: number; code?: string } = { status: r.status };
    if (serverCode !== undefined) {
      opts.code = serverCode;
    }
    throw new ActionError(serverError !== "" ? serverError : `HTTP ${String(r.status)}`, opts);
  }
  if (r.status === 204) {
    return undefined as T;
  }
  const text = await r.text();
  if (text === "") {
    if (spec.method !== "DELETE") {
      console.warn(
        `[actions] ${spec.method} ${spec.path} returned empty body — callers expecting data will receive undefined`,
      );
    }
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new ActionError(`response not JSON: ${e instanceof Error ? e.message : String(e)}`, {
      status: r.status,
      cause: e,
    });
  }
}
