# actions

[![CI](https://github.com/cplieger/actions/actions/workflows/ci.yaml/badge.svg)](https://github.com/cplieger/actions/actions/workflows/ci.yaml)
[![npm](https://img.shields.io/npm/v/@cplieger/actions)](https://www.npmjs.com/package/@cplieger/actions)
[![JSR](https://jsr.io/badges/@cplieger/actions)](https://jsr.io/@cplieger/actions)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](./LICENSE)

> Declarative UI-actions framework with lifecycle management, retry, debounce, and polling.

A standalone TypeScript library for defining and dispatching UI actions with full lifecycle support: optimistic updates, automatic retry with backoff, scope serialization, dedupe collapsing, notification wiring, and a registry for observability. Zero runtime dependencies — notification display and streaming transport are injected by the consumer via small interfaces.

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

- **Notifier** (`configure()`): Provides `success(msg)` and `error(msg, retry?)` methods for displaying notifications. Without configuration, notifications are silently dropped.

- **API** (`configureApi()`): Configures the HTTP layer used by all `apiAction` instances — base URL, auth/CSRF headers, credentials mode, or a custom fetch implementation. Without configuration, `apiAction` uses the global `fetch` with relative paths.

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

- `baseUrl` — prepended to every `RequestSpec.path`
- `prepareHeaders(headers, { spec })` — inject headers per-request (may be async)
- `credentials` — `RequestInit.credentials` mode (e.g. `"include"` for cookies)
- `fetchFn` — custom fetch implementation (SSR, testing)

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

## API

- `configure(notifier)` — inject the notification adapter
- `configureApi(opts)` — configure the HTTP layer (baseUrl, headers, credentials, fetchFn)
- `configureTransport(fn)` — inject the streaming transport adapter
- `defineAction(def)` — create an action from a declarative definition
- `apiAction(def)` — create an HTTP-backed action (uses `fetch`)
- `transportAction(def)` — create a transport/SSE-backed action
- `debouncedDispatch(action, opts)` — debounce wrapper
- `pollAction(action, args, opts)` — interval polling with pause/backoff
- `bindLoadingState(name, el, opts?)` — bind element disabled state to action pending
- `subscribeToActions(fn)` — subscribe to all lifecycle events
- `subscribeByName(name, fn)` — subscribe to lifecycle events for a single action name
- `getActionLog()` — read the recent action log (for devtools/debugging)
- `pendingCount(names?)` — query pending action count
- `isPending(name)` — O(1) check if a named action is in-flight
- `registerCleanup(fn)` — register teardown hooks for page unload
- `ActionError` — structured error class with status/code
- `retryNetwork` — preset retry classifier for transient failures
- `classifyFetchError(err)` — classify fetch errors (network vs timeout vs HTTP)
- `hasErrorString(err)` — type guard for objects with a `.message` string
- `withTimeout(signal, ms)` — compose an AbortSignal with a timeout
- `API_TIMEOUT_MS` — default API request timeout (30 000 ms)
- `RETRY_STANDARD` — standard retry config (2 retries, 300ms)

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

`dispatch()` returns a `DispatchHandle` — a Promise augmented with an `abort()` method for per-dispatch cancellation:

```typescript
const handle = action.dispatch(args);
// Cancel just this dispatch (others unaffected):
handle.abort();
// Still awaitable:
const result = await handle;
```

### Timeout option

`ActionDefinition` accepts a `timeout` (ms) that aborts `run()` via `AbortSignal.timeout()`:

```typescript
const slow = defineAction({
  name: "slow.op",
  timeout: 5000, // abort after 5s
  run: async (args, signal) => fetch(url, { signal }),
});
```

## Unsupported by Design (SKIP list)

The following features are intentionally not implemented:

| Feature                                | Reason                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Query caching / stale-while-revalidate | Out of paradigm — this is an action runner, not a data cache. Use TanStack Query alongside.       |
| Cache invalidation / revalidation      | Data-cache concern, out of scope.                                                                 |
| Framework adapters (React/Vue/Svelte)  | Vanilla TS by design. Framework bindings belong in separate packages.                             |
| Visual DevTools panel                  | Separate package concern. The registry API (`getActionLog`, `subscribeByName`) provides the data. |
| SSR / hydration                        | Actions are imperative mutations — nothing to serialize across server→client.                     |
| Debounce `maxWait`                     | Deliberate simplification. Use `flush()` for guaranteed-fire semantics.                           |
| Throttle helper                        | Not action-specific. Consumers can throttle before calling `dispatch()`.                          |
| `condition` / pre-execution guard      | Trivially implemented by callers with `if`. `dedupe` covers the primary use case.                 |
| Typed discriminated-union result       | The callback model (onSuccess/onError/onSettled) is the chosen API shape.                         |
| `onProgress` callback                  | Transport-specific. Consumers wire progress in their `run()` implementation.                      |
| Batch dispatch                         | Store-level concern. This library doesn't own a store.                                            |
| `dispose()` / action deregistration    | Actions are lightweight when idle. Not a leak concern for realistic app sizes.                    |

## License

GPL-3.0 — see [LICENSE](LICENSE).
