# actions

[![npm](https://img.shields.io/npm/v/@cplieger/actions)](https://www.npmjs.com/package/@cplieger/actions)
[![JSR](https://jsr.io/badges/@cplieger/actions)](https://jsr.io/@cplieger/actions)
[![Test coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/cplieger/actions/badges/coverage.json)](https://github.com/cplieger/actions/actions/workflows/coverage.yml)
[![Mutation (TS)](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/cplieger/actions/badges/mutation-ts.json)](https://github.com/cplieger/actions/issues?q=label%3Astryker-tracker)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13197/badge)](https://www.bestpractices.dev/projects/13197)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/cplieger/actions/badge)](https://scorecard.dev/viewer/?uri=github.com/cplieger/actions)

> Declarative UI-actions framework with lifecycle management, retry, debounce, and polling.

A standalone TypeScript library for defining and dispatching UI actions with full lifecycle support: optimistic updates, automatic retry with backoff, scope serialization, dedupe collapsing, notification wiring, polling, button-feedback helpers, and a registry for observability. Two runtime dependencies: [`@cplieger/reactive`](https://github.com/cplieger/reactive) backs the reactive pending-state (`isPending`/`pendingCount`), and [`@cplieger/fetch`](https://github.com/cplieger/fetch) carries `apiAction` HTTP requests. Notification display and streaming transport are injected by the consumer via small interfaces.

## Install

```sh
npx jsr add @cplieger/actions
# or
npm i @cplieger/actions
```

Requires TypeScript ≥ 5.0 and a bundler that supports ESM.

## Usage

```typescript
import { configure, defineAction, apiAction, retryNetwork } from "@cplieger/actions";

// Wire up your notification adapter at boot
configure({
  success: (msg) => showToast("success", msg),
  error: (msg, retry) => showToast("error", msg, retry?.onClick),
});

// Define an action backed by HTTP
const deleteItem = apiAction<string>({
  name: "items.delete",
  request: (id) => ({ method: "DELETE", path: `/api/items/${id}` }),
  error: "Couldn't delete item",
  retryable: retryNetwork,
  retry: { count: 2, delay: 300 },
});

// Dispatch it
await deleteItem.dispatch(itemId);
```

## Injection Points

The framework provides three adapter injection points:

- **Notifier** (`configure()`): Provides `success(msg)` and `error(msg, retry?)` methods for displaying notifications. Without configuration, notifications are dropped and the framework warns once on the first drop; a forgotten `configure()` call is otherwise invisible. Call `configure({})` to opt into intentional headless silence (tests, non-UI environments); an explicitly configured notifier never warns, even with missing methods.

- **API** (`configureApi()`): Configures the HTTP layer used by all `apiAction` instances: base URL, auth/CSRF headers, credentials mode, or a custom fetch implementation. Without configuration, `apiAction` uses the global `fetch` with relative paths.

- **Transport** (`configureTransport()`): Provides a `send(cmd, opts)` function for SSE/streaming actions. Only needed if using `transportAction`.

### HTTP Customization (configureApi)

```typescript
import { configureApi } from "@cplieger/actions";

configureApi({
  baseUrl: "https://api.example.com/v1",
  credentials: "include",
  prepareHeaders: (headers, { spec }) => {
    headers.set("Authorization", `Bearer ${getToken()}`);
    headers.set("X-CSRF-Token", getCsrfToken());
  },
});
```

Options (mirrors RTK `fetchBaseQuery`):

- `baseUrl`: prepended to every `RequestSpec.path`
- `prepareHeaders(headers, { spec })`: inject headers per-request (may be async)
- `credentials`: `RequestInit.credentials` mode (e.g. `"include"` for cookies)
- `fetchFn`: custom fetch implementation (SSR, testing)

> **Path contract:** `RequestSpec.path` is expected to be a **relative** path. With `baseUrl` set, the configured scheme+host always precede it, so an absolute (`https://…`) or protocol-relative (`//host`) path is neutralised (kept as a path segment) and cannot override the origin. With `baseUrl` **unset**, `path` is passed to `fetch()` verbatim; the caller owns the full URL and must never pass untrusted input (e.g. a server-supplied string) as the whole path.

Per-request headers can also be set directly on `RequestSpec`:

```typescript
const action = apiAction({
  name: "items.create",
  request: (item) => ({
    method: "POST",
    path: "/items",
    body: item,
    headers: { "X-Request-Id": crypto.randomUUID() },
  }),
});
```

### Response decoding (apiAction `decode` / `decodeError`)

By default `apiAction` treats any 2xx as success and any failure as an
`ActionError`. Two optional hooks own the interpretation for servers that
speak nonstandard envelopes:

`decode(data, { status, spec })` runs on every 2xx. Return the action result,
or **throw** to route the dispatch to the error branch (rollback, error
notification, registry error status). This is the seam for 200-with-error
envelopes:

```typescript
const stage = apiAction<{ repo: string }, { output?: string }>({
  name: "git.stage",
  request: (args) => ({ method: "POST", path: "/api/git/stage", body: args }),
  // The server replies HTTP 200 for both outcomes; a non-empty `error`
  // field is the failure signal.
  decode: (data) => {
    if (hasErrorString(data) && data.error !== "") {
      throw new ActionError(data.error, { code: "git" });
    }
    return data as { output?: string };
  },
});
```

`decodeError(info, { spec })` runs on every failure that produced a real HTTP
response. `info` carries `status`, `message`, `code?`, the parsed JSON
`body?`, and `headers?`. Return `{ kind: "success", value }` to resolve the
dispatch as success (a 409 whose body is a meaningful payload), `{ kind:
"error", error }` to replace the default error, or `undefined` to keep the
default mapping:

```typescript
const deleteTool = apiAction<{ name: string }, DeleteToolResult>({
  name: "tools.delete",
  request: ({ name }) => ({ method: "DELETE", path: `/api/tools/${name}` }),
  error: false, // 409 cascade is a normal flow, handled by the caller
  decodeError: (info) =>
    info.status === 409
      ? { kind: "success", value: (info.body ?? {}) as DeleteToolResult }
      : undefined,
});
```

Transport-level failures (network / timeout / cancellation, `status` 0)
never reach `decodeError`, so `retryNetwork` classification and cancellation
semantics can't be accidentally rewritten. `info.body` is server-controlled
input: validate its shape before reading fields.

For nonstandard **request** bodies, `RequestSpec.rawBody` is the encoder
seam: a pre-encoded `BodyInit` sent as-is (no JSON encoding, no automatic
Content-Type; set the type via `headers`), computed per dispatch by the
`request()` function:

```typescript
const saveConfig = apiAction<string, unknown>({
  name: "config.save",
  request: (yaml) => ({
    method: "PUT",
    path: "/api/config",
    rawBody: yaml,
    headers: { "Content-Type": "text/yaml" },
  }),
});
```

`run()` on a plain `defineAction` remains the universal escape hatch for wire
contracts beyond these seams.

## API

- `configure(notifier)`: inject the notification adapter
- `configureApi(opts)`: configure the HTTP layer (baseUrl, headers, credentials, fetchFn)
- `configureTransport(fn)`: inject the streaming transport adapter
- `defineAction(def)`: create an action from a declarative definition. Keep names unique: duplicates get a one-time warning, and the name-keyed helpers (`isPending`, `subscribeByName`, `bindLoadingState`) conflate them
- `apiAction(def)`: create an HTTP-backed action (uses `fetch`); optional `decode` / `decodeError` hooks own nonstandard-envelope interpretation (see above)
- `transportAction(def)`: create a transport/SSE-backed action
- `debouncedDispatch(action, opts)`: debounce wrapper
- `pollAction(action, args, opts)`: interval polling with pause/backoff
- `bindLoadingState(name, el, opts?)`: bind an element's disabled/aria-busy state to action pending. The binding auto-disposes when the element leaves the DOM; a re-attached element (e.g. a list re-render reusing nodes) needs a fresh call
- `pollUntil(step, opts)`: one-shot poll until a terminal condition (`until` predicate, `maxAttempts`/`timeoutMs` budgets, backoff on transient errors); returns `{status:'done'|'timeout'|'aborted'}`
- `withAsyncFeedback(btn, fn, opts?)`: per-button async feedback (spinner, then outcome glyph, then restore) with a re-entry guard and screen-reader announcement. `target` scopes the cycle to a child slot; `resetMs: 0` persists the outcome glyph
- `subscribeToActions(fn)`: subscribe to all lifecycle events (discrete event stream)
- `subscribeByName(name, fn)`: subscribe to lifecycle events for a single action name (discrete event stream)
- `getActionLog()`: read the recent action log (for devtools/debugging)
- `pendingCount(names?)`: pending action count; reactive (tracks inside an effect)
- `isPending(name)`: check if a named action is in-flight; reactive (tracks inside an effect)
- `registerCleanup(fn)`: register teardown hooks for page unload
- `ActionError`: structured error class with status/code
- `retryNetwork`: preset retry classifier for transient failures
- `classifyFetchError(err)`: classify fetch errors (network vs timeout vs HTTP)
- `hasErrorString(err)`: type guard for objects with a `.message` string
- `RETRY_STANDARD`: standard retry config (2 retries, 300ms)
- `IDEMPOTENCY_HEADER`: the `Idempotency-Key` HTTP header name `apiAction` sets from `ctx.idempotencyKey`; import it in custom `run()` implementations instead of hand-copying the literal
- `IDEMPOTENCY_COMMAND_FIELD`: the `idempotency_key` command field `transportAction` injects; same sharing purpose for custom transport runners

> `withTimeout(signal, ms)` and `API_TIMEOUT_MS` moved to [`@cplieger/fetch`](https://github.com/cplieger/fetch) (the layer that owns timeout composition); import them from there.

### Test utilities (`@cplieger/actions/testing`)

The `./testing` subpath exports test-only helpers. Import only from test code:

```typescript
import { resetActionFramework } from "@cplieger/actions/testing";

beforeEach(() => {
  resetActionFramework();
});
```

- `resetActionFramework()`: clear every framework state slot (define, registry, cleanup, api, transport, notifier). Call from `beforeEach()` to isolate tests.

> **Breaking change in v2.0:** the `./src/*` deep-import escape hatch was removed
> from `package.json` exports. Migrate any deep `/src/*` import to
> `@cplieger/actions/testing` (`resetActionFramework()`), or to the public API
> for everything else. The [release notes](https://github.com/cplieger/actions/releases)
> list the removed subpaths and the old `_reset*ForTest` helpers that
> `resetActionFramework()` supersedes.

### Definition-level callbacks (TanStack Query pattern)

`ActionDefinition` supports `onSuccess`, `onError`, and `onSettled` callbacks that fire on every dispatch without the caller needing to pass them each time:

```typescript
const save = defineAction({
  name: "doc.save",
  run: async (id: string) => api.save(id),
  onSuccess: (result, id) => invalidateCache(id),
  onError: (err, id) => trackError("save", id, err),
  onSettled: (id) => console.log("save settled for", id),
});
```

### Per-dispatch abort handle (RTK pattern)

`dispatch()` returns a `DispatchHandle`, a Promise augmented with an `abort()` method for per-dispatch cancellation:

```typescript
const handle = action.dispatch(args);
// Cancel just this dispatch (others unaffected):
handle.abort();
// Still awaitable:
const result = await handle;
```

### Typed outcome accessor (`handle.outcome`)

The handle itself resolves to a never-rejecting `TResult | null`, which
collapses three terminal states and makes a legitimately-`null` result
indistinguishable from failure. `handle.outcome` is the typed accessor for
callers that need the distinction:

```typescript
const handle = action.dispatch(args);
const outcome = await handle.outcome; // never rejects
switch (outcome.status) {
  case "success":
    use(outcome.value); // TResult, including a legitimate null
    break;
  case "error":
    show(outcome.error.message); // the normalized ActionErrorLike
    break;
  case "cancelled":
    break; // abort() / action.cancel() / timeout-as-abort
}
```

`outcome.attempts` carries the run count when the dispatch actually ran
(retries increment it); a dedupe-joined dispatch resolves with the shared
result but no attempts. Reach for `.outcome` when a call site consumes the
terminal state inline; the never-rejecting promise and the callback tiers
(`onSuccess`/`onError`/`onSettled`) remain the canonical surface.

### Timeout option

`ActionDefinition` accepts a `timeout` (ms) that aborts `run()` via `AbortSignal.timeout()`:

```typescript
const slow = defineAction({
  name: "slow.op",
  timeout: 5000, // abort after 5s
  run: async (args, signal) => fetch(url, { signal }),
});
```

## Unsupported by Design

The following features are intentionally not implemented:

| Feature                                | Reason                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Query caching / stale-while-revalidate | Out of paradigm: this is an action runner, not a data cache. Use TanStack Query alongside.        |
| Cache invalidation / revalidation      | Data-cache concern, out of scope.                                                                 |
| Framework adapters (React/Vue/Svelte)  | Vanilla TS by design. Framework bindings belong in separate packages.                             |
| Visual DevTools panel                  | Separate package concern. The registry API (`getActionLog`, `subscribeByName`) provides the data. |
| SSR / hydration                        | Actions are imperative mutations; nothing to serialize across server→client.                      |
| Debounce `maxWait`                     | Deliberate simplification. Use `flush()` for guaranteed-fire semantics.                           |
| Throttle helper                        | Not action-specific. Consumers can throttle before calling `dispatch()`.                          |
| `condition` / pre-execution guard      | Trivially implemented by callers with `if`. `dedupe` covers the primary use case.                 |
| `onProgress` callback                  | Transport-specific. Consumers wire progress in their `run()` implementation.                      |
| Batch dispatch                         | Store-level concern. This library doesn't own a store.                                            |
| `dispose()` / action deregistration    | Actions are lightweight when idle. Not a leak concern for realistic app sizes.                    |

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
conventions and how to run the checks locally.

## Disclaimer

This project is built with care and follows security best practices, but it is intended for personal / self-hosted use. No guarantees of fitness for production environments. Use at your own risk.

This project was built with AI-assisted tooling using [Claude](https://claude.com), [GPT](https://openai.com), and [Kiro](https://kiro.dev). The human maintainer defines architecture, supervises implementation, and makes all final decisions.

## License

Apache-2.0. See [LICENSE](LICENSE).
