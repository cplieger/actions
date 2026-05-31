# actions

> Declarative UI-actions framework with lifecycle management, retry, debounce, and polling.

A standalone TypeScript library for defining and dispatching UI actions with full lifecycle support: optimistic updates, automatic retry with backoff, scope serialization, dedupe collapsing, toast/notification wiring, and a registry for observability. Zero runtime dependencies — notification display and HTTP transport are injected by the consumer via small interfaces.

## Install

<!-- TODO: registry/pull link -->

TS: `npx jsr add @cplieger/actions` or `npm i @cplieger/actions`

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

The framework requires one adapter to be injected at boot:

- **Notifier** (`configure()`): Provides `success(msg)` and `error(msg, retry?)` methods for displaying notifications. Without configuration, notifications are silently dropped.

The `apiAction` helper uses the global `fetch` — no HTTP client injection needed.

## API

- `configure(notifier)` — inject the notification adapter
- `defineAction(def)` — create an action from a declarative definition
- `apiAction(def)` — create an HTTP-backed action (uses `fetch`)
- `debouncedDispatch(action, opts)` — debounce wrapper
- `pollAction(action, args, opts)` — interval polling with pause/backoff
- `bindLoadingState(name, el, opts?)` — bind element disabled state to action pending
- `subscribeToActions(fn)` — subscribe to all lifecycle events
- `pendingCount(names?)` — query pending action count
- `registerCleanup(fn)` — register teardown hooks for page unload
- `ActionError` — structured error class with status/code
- `retryNetwork` — preset retry classifier for transient failures
- `RETRY_STANDARD` — standard retry config (2 retries, 300ms)

## License

GPL-3.0 — see [LICENSE](LICENSE).
