# actions

[![npm](https://img.shields.io/npm/v/@cplieger/actions)](https://www.npmjs.com/package/@cplieger/actions)
[![JSR](https://jsr.io/badges/@cplieger/actions)](https://jsr.io/@cplieger/actions)
[![Test coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/cplieger/actions/badges/coverage.json)](https://github.com/cplieger/actions/actions/workflows/coverage.yml)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13197/badge)](https://www.bestpractices.dev/projects/13197)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/cplieger/actions/badge)](https://scorecard.dev/viewer/?uri=github.com/cplieger/actions)

> Declarative UI-actions framework with lifecycle management, retry, debounce, and polling.

A standalone TypeScript library for defining and dispatching UI actions with full lifecycle support: optimistic updates, automatic retry with backoff, scope serialization, dedupe collapsing, notification wiring, polling, button-feedback helpers, and a registry for observability. Built on [`@cplieger/reactive`](https://github.com/cplieger/reactive) — action pending-state is signal-backed, so `isPending`/`pendingCount` are reactive and `bindLoadingState` is a plain effect over them. Notification display and streaming transport are injected by the consumer via small interfaces.

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
- `bindLoadingState(name, el, opts?)` — bind an element's disabled/aria-busy state to action pending; a reactive effect over the pending signals
- `pollUntil(step, opts)` — poll until a terminal condition (wait-then-poll, `until` predicate, `maxAttempts`/`timeoutMs` budgets, backoff-on-transient); returns `{status:'done'|'timeout'|'aborted'}`. A standalone sibling to `pollAction` for one-shot terminal-state waits.
- `withAsyncFeedback(btn, fn, opts?)` — per-button async feedback (spinner → ✓/✗ → restore) with a re-entry guard + sr-only announce + injectable glyphs. `target?: HTMLElement` runs the cycle on a child slot via in-place element replacement (siblings/label untouched); `resetMs: 0` persists the outcome glyph (no auto-revert).
- `subscribeToActions(fn)` — subscribe to all lifecycle events (discrete event stream)
- `subscribeByName(name, fn)` — subscribe to lifecycle events for a single action name (discrete event stream)
- `getActionLog()` — read the recent action log (for devtools/debugging)
- `pendingCount(names?)` — pending action count; reactive (tracks inside an effect)
- `isPending(name)` — check if a named action is in-flight; reactive (tracks inside an effect)
- `registerCleanup(fn)` — register teardown hooks for page unload
- `ActionError` — structured error class with status/code
- `retryNetwork` — preset retry classifier for transient failures
- `classifyFetchError(err)` — classify fetch errors (network vs timeout vs HTTP)
- `hasErrorString(err)` — type guard for objects with a `.message` string
- `withTimeout(signal, ms)` — compose an AbortSignal with a timeout
- `API_TIMEOUT_MS` — default API request timeout (30 000 ms)
- `RETRY_STANDARD` — standard retry config (2 retries, 300ms)

### Test utilities (`@cplieger/actions/testing`)

The `./testing` subpath exports test-only helpers. Import only from test code:

```typescript
import { resetActionFramework } from "@cplieger/actions/testing";

beforeEach(() => {
  resetActionFramework();
});
```

- `resetActionFramework()` — clear every framework state slot (define, registry, cleanup, api, transport, notifier). Call from `beforeEach()` to isolate tests.

> **Breaking change in v2.0:** the `./src/*` deep-import escape hatch was removed
> from `package.json` exports. Consumers that previously reached into
> `@cplieger/actions/src/define`, `…/src/registry`, `…/src/cleanup`,
> `…/src/api`, `…/src/transport`, or `…/src/notifier` to call
> `_resetForTest`/`_resetApiConfigForTest`/`_resetTransportForTest`/
> `_resetNotifierForTest` must migrate to
> `@cplieger/actions/testing` for `resetActionFramework()`, or to the
> public surface for everything else.

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
