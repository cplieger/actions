// apiAction: factory for HTTP-backed actions. Wraps fetch so the run()
// implementation is just the request descriptor.
// ---------------------------------------------------------------------------

import { defineAction, IDEMPOTENCY_HEADER } from "./define.js";
import { ActionError, classifyFetchError, hasErrorString } from "./error.js";
import type { Action, ActionContext, ActionDefinition, RequestSpec } from "./types.js";

/** Default request timeout in milliseconds. */
export const API_TIMEOUT_MS = 30_000;

/** Compose an optional caller signal with a fresh timeout signal. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal !== undefined
    ? AbortSignal.any([signal, AbortSignal.timeout(ms)])
    : AbortSignal.timeout(ms);
}

const JSON_HEADERS: Readonly<Record<string, string>> = { "Content-Type": "application/json" };

/** Caller-facing shape of an apiAction definition. */
interface ApiActionDefinition<TArgs, TResult, TOp = unknown> extends Omit<
  ActionDefinition<TArgs, TResult, TOp>,
  "run"
> {
  request: (args: TArgs) => RequestSpec;
}

/**
 * Build an Action from an HTTP request descriptor.
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
  const init: RequestInit = { method: spec.method };
  const headers: Record<string, string> = {};
  if (spec.method !== "GET" && spec.body !== undefined) {
    Object.assign(headers, JSON_HEADERS);
    init.body = JSON.stringify(spec.body);
  }
  if (ctx?.idempotencyKey !== undefined) {
    headers[IDEMPOTENCY_HEADER] = ctx.idempotencyKey;
  }
  if (Object.keys(headers).length > 0) {
    init.headers = headers;
  }
  init.signal = withTimeout(signal, API_TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(spec.path, init);
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
