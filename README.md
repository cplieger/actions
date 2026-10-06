# actions

[![npm](https://img.shields.io/npm/v/@cplieger/actions)](https://www.npmjs.com/package/@cplieger/actions) [![JSR](https://jsr.io/badges/@cplieger/actions)](https://jsr.io/@cplieger/actions) [![Mutation (TS)](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/cplieger/actions/badges/mutation-ts.json)](https://github.com/cplieger/actions/issues?q=label%3Astryker-tracker)

actions gives every server call in your TypeScript UI the same pending state, retry, rollback and messages, from one declaration per action.

It replaces the loading flag, error message and undo code you would otherwise write around each call that changes server data. Optimistic updates and retry are opt-in, and no UI framework is needed. It needs TypeScript 5.0 or later and an ESM bundler. It depends on [`@cplieger/reactive`](https://github.com/cplieger/reactive) and [`@cplieger/fetch`](https://github.com/cplieger/fetch) and is licensed under Apache-2.0.

## Why use it

actions is built for vanilla TypeScript front ends that want the same behavior on every server call.

- An optimistic update changes the UI before the request, and a rollback undoes it on failure or cancellation.
- Retry backs off exponentially, retries only failures you mark as transient, and pauses while the browser is offline.
- `scope` runs same-key dispatches in order, `dedupe` joins them into one request, and `abort()` cancels a single dispatch.
- `isPending` and `pendingCount` are reactive through `@cplieger/reactive`, so a button can disable itself while its action runs.
- A failure or a cancellation resolves the dispatch to `null` instead of rejecting, with [two exceptions](docs/lifecycle.md#order-of-a-dispatch), and `handle.outcome` tells the three endings apart.
- `onSuccess`, `onError` and `onSettled` follow TanStack Query's mutation callbacks, and `configureApi` follows RTK Query's `fetchBaseQuery`.
- Only `bindLoadingState` and `withAsyncFeedback` need a DOM. The rest also runs in Node.

Consider [TanStack Query](https://tanstack.com/query/latest) if you also need a server-state cache, with cache invalidation after a mutation and framework hooks such as React's `useMutation`.

## Install

```sh
npx jsr add @cplieger/actions
# or
npm i @cplieger/actions
```

## Usage

Connect your notification display once at startup, define each action at module scope, then dispatch it from your event handlers.

```typescript
import { configure, apiAction, retryNetwork } from "@cplieger/actions";

configure({
  success: (msg) => showToast("success", msg),
  error: (msg, retry) => showToast("error", msg, retry?.onClick),
});

const deleteItem = apiAction<string>({
  name: "items.delete",
  request: (id) => ({ method: "DELETE", path: `/api/items/${id}` }),
  error: "Could not delete the item",
  retryable: retryNetwork,
  retry: { count: 2, delay: 300 },
});

await deleteItem.dispatch(itemId);
```

`dispatch()` resolves to the result, or to `null` after a failure or a cancellation. After a failure, the error message has already been shown. Retry needs both settings. `retryable` decides which failures are transient, and `retry` sets the number of attempts and the wait. With `retry` alone, nothing is retried.

An optimistic update returns what the rollback needs to restore:

```typescript
const toggleDone = apiAction<{ id: string; done: boolean }, Todo, Todo>({
  name: "todos.toggle",
  request: ({ id, done }) => ({ method: "PATCH", path: `/api/todos/${id}`, body: { done } }),
  optimistic: ({ id, done }) => {
    const previous = store.get(id);
    store.setDone(id, done);
    return previous;
  },
  rollback: ({ id }, previous) => {
    if (previous) store.set(id, previous);
  },
  scope: ({ id }) => `todo:${id}`,
});
```

`rollback` runs on an error or a cancellation, never on success. `scope` makes two toggles of the same item run one after the other.

To disable a button while its action runs, and to read the result with its status:

```typescript
bindLoadingState("todos.toggle", toggleButton);

const outcome = await toggleDone.dispatch({ id, done: true }).outcome;
if (outcome.status === "error") console.warn(outcome.error.message);
```

## API

- Setup, once at startup: `configure` connects your notification display, and `configureApi` sets the base URL, headers and credentials of HTTP actions. `configureTransport` connects the channel for streaming commands, such as an endpoint whose replies arrive over server-sent events.
- Factories: `defineAction` for any async function, `apiAction` for HTTP requests, `transportAction` for streaming commands.
- Helpers: `debouncedDispatch`, `pollAction`, `pollUntil`, `bindLoadingState`, `withAsyncFeedback`, `registerCleanup`.
- State and events: `isPending`, `pendingCount`, `subscribeToActions`, `subscribeByName`, `getActionLog`.
- Errors and presets: `ActionError`, `retryNetwork`, `classifyFetchError`, `hasErrorString`, `RETRY_STANDARD`, `IDEMPOTENCY_HEADER`, `IDEMPOTENCY_COMMAND_FIELD`.
- Tests: `resetActionFramework` from `@cplieger/actions/testing`, for `beforeEach`.

The full reference, generated from the doc comments, is on [JSR](https://jsr.io/@cplieger/actions/doc).

## Server text and arguments need care

- An error message can include text from the server's response. Your `configure` adapter renders it as text, never as HTML.
- In `decodeError`, `info.body` is the parsed body of a failed response. Check its shape before you read a field.
- With `baseUrl` set, a request path cannot change the origin. Without `baseUrl`, the path goes to `fetch()` unchanged, so never build a whole path from server text.
- The action log and the retry button keep each dispatch's arguments in memory. Keep secrets, tokens and personal data out of action arguments.

## Unsupported by design

| Feature | Reason |
| --- | --- |
| Query caching, stale-while-revalidate | This is an action runner, not a data cache. Use TanStack Query alongside it. |
| Cache invalidation, revalidation | A data-cache concern. |
| Framework adapters for React, Vue or Svelte | Vanilla TypeScript by design. Framework bindings belong in separate packages. |
| Visual DevTools panel | A separate package. `getActionLog` and `subscribeByName` give it the data. |
| SSR and hydration | Actions are imperative mutations, with no state to carry from server to client. |
| Debounce `maxWait` | A deliberate simplification. Call `flush()` when a dispatch must fire. |
| Throttle helper | Not specific to actions. Throttle before you call `dispatch()`. |
| `condition` or a pre-execution guard | An `if` in the caller does it. `dedupe` covers the main case. |
| `onProgress` callback | Transport-specific. Report progress from your `run()` function. |
| Batch dispatch | A store concern, and this library does not own a store. |
| `dispose()` or action deregistration | An idle action holds little memory, so a realistic app does not leak. |

## Documentation

- [Dispatch lifecycle](docs/lifecycle.md) covers notifications, retry, concurrency, cancellation, callbacks and the typed outcome.
- [HTTP and streaming actions](docs/http.md) covers `configureApi`, request paths, response decoding and `transportAction`.
- [UI and polling helpers](docs/helpers.md) covers debounce, polling, loading state, button feedback, observability and testing.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

This project is built with care and follows security best practices, but it is intended for personal / self-hosted use. No guarantees of fitness for production environments. Use at your own risk.

This project was built with AI-assisted tooling using [Claude](https://claude.com), [GPT](https://openai.com), and [Kiro](https://kiro.dev). The human maintainer defines architecture, supervises implementation, and makes all final decisions.

## License

Apache-2.0. See [LICENSE](LICENSE).
