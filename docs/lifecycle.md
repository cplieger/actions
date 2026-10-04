# Dispatch lifecycle

This page describes what happens between `dispatch()` and its result, for developers who tune notifications, retry, concurrency or cancellation on an action.

## Order of a dispatch

A dispatch that runs gets its own id, cancellation signal and entry in the action log. A call that joins a dispatch in flight through `dedupe` reuses that dispatch's promise and gets none of the three. A dispatch runs in this order:

1. With `dedupe` set, a dispatch whose key matches one already in flight joins that dispatch and stops here.
2. With `scope` set, the dispatch waits for earlier dispatches with the same scope key.
3. `optimistic` runs synchronously.
4. `run()` runs, and runs again for each retry the settings allow.
5. On success, the success notification and the success callbacks fire. On an error, `rollback` runs, then the error notification and the error callbacks fire. On a cancellation, only `rollback` runs.
6. `onSettled` fires in every case.

`dispatch()` resolves to the result, or to `null` after a failure or a cancellation. It rejects in two cases, both caused by code you pass in. An `idempotencyKey` function that throws rejects the dispatch, and so does a thrown value whose `message` cannot be read. In both cases `handle.outcome` of that dispatch never settles. A `scope` or `dedupe` function that throws makes `dispatch()` itself throw.

A throw from `onSuccess`, `onError`, `onSettled`, `rollback` or a notification message function is logged to the console and leaves the outcome unchanged. A throw from `optimistic` fails the dispatch before `run()` starts, with the code `optimistic_failed` unless the thrown error carries its own code.

## Notifications

`configure({ success, error })` connects your display. Both methods are optional.

- Before `configure` is called, notifications are dropped, and the first drop logs one console warning.
- `configure({})` turns notifications off on purpose, for tests or a headless page, and never warns.
- `success` on a definition sets the success message. With no `success`, nothing is shown.
- `error` on a definition sets the error message. A string becomes `"<your text>: <error message>"`, a function returns the whole message, and `false` shows nothing.
- With no `error`, the message is built from the last part of the action name, so `chat.delete` shows `"Delete failed: <error message>"`.
- When the error passes the action's `retryable` classifier, `error(msg, retry)` also receives a retry handler that dispatches the same arguments again.
- `dispatch(args, { silent: true })` skips the success message for one call. Errors still show.

An error message can carry text from the server's response, so render it as text, never as HTML.

## Optimistic updates and rollback

`optimistic(args)` runs before `run()` and returns any value. `rollback(args, value, error)` receives that value back.

`rollback` runs on an error and on a cancellation, including a cancellation that lands after `run()` resolved. It never runs on success. On the cancellation path, `error` is `{ message: "cancelled", code: "cancelled" }`.

## Retry

Retry needs two settings. `retryable(error)` decides whether a failure may be retried, and `retry` says how often and how long to wait. With `retry` and no `retryable`, the action never retries.

- `retry.count` is the number of extra attempts, so `count: 2` means up to three runs.
- A number `retry.delay` is the first wait in milliseconds. Each later wait is multiplied by `retry.factor`, 2 by default, up to 5 seconds.
- A function `retry.delay(attempt, error)` returns each wait itself.
- `RETRY_STANDARD` is `{ count: 2, delay: 300 }`.
- `retryNetwork` retries network failures, timeouts of the HTTP request, and the statuses 408, 429, 502, 503 and 504. It never retries a cancellation.
- With `networkMode: "online"`, the default, a retry waits until the browser reports it is back online. `networkMode: "always"` retries without waiting.

## Concurrency

Three settings answer three different questions.

- `scope` serializes. Dispatches with the same scope key run one after the other, in dispatch order. A string gives every dispatch the same key, and a function derives the key from the arguments.
- `dedupe` collapses. A dispatch whose key matches one in flight resolves with that dispatch's result and sends no request of its own. `dedupe: true` keys on the serialized arguments, and a function returns the key. A joined dispatch runs its own callbacks, and its outcome carries no `attempts`.
- `handle.abort()` cancels one dispatch, and `action.cancel()` cancels every dispatch of that action in flight. `abort()` does nothing on a handle that joined through `dedupe`.

## Cancellation and timeouts

Cancellation is cooperative. `abort()`, `cancel()` and `timeout` abort the `AbortSignal` passed to `run(args, signal)`, and nothing more. A `run()` that ignores the signal runs to completion. After `abort()` or `cancel()`, its result is discarded and the dispatch ends as cancelled. After a `timeout`, a result that still arrives counts as a success.

```typescript
const handle = action.dispatch(args);
handle.abort(); // cancels this dispatch only
const result = await handle; // null
```

`timeout` on a definition is a limit in milliseconds for every run and retry wait of a dispatch. It starts after any wait for an earlier dispatch with the same `scope` key. When the signal stops `run()`, or the time runs out during a retry wait, the dispatch is not retried and ends as an error with the code `timeout`.

```typescript
const slow = defineAction({
  name: "slow.op",
  timeout: 5000,
  run: async (args, signal) => fetch(url, { signal }),
});
```

Every action is registered for page unload, so a `beforeunload` event cancels all dispatches in flight.

## Callbacks

`onSuccess`, `onError` and `onSettled` on the definition fire on every dispatch, in the shape of [TanStack Query's mutation callbacks](https://tanstack.com/query/latest/docs/framework/react/guides/mutations):

```typescript
const save = defineAction({
  name: "doc.save",
  run: async (id: string) => api.save(id),
  onSuccess: (result, id) => invalidateCache(id),
  onError: (err, id) => trackError("save", id, err),
  onSettled: (id) => console.log("save settled for", id),
});
```

`dispatch(args, { onSuccess, onError, onSettled })` adds callbacks for one call. They fire after the notification, and `onSettled` fires for a cancellation too.

## The typed outcome

The handle resolves to `TResult | null`, so a result that is legitimately `null` looks the same as a failure. `handle.outcome` never rejects, and for a dispatch that ends it tells the three endings apart:

```typescript
const outcome = await action.dispatch(args).outcome;
switch (outcome.status) {
  case "success":
    use(outcome.value); // TResult, including a legitimate null
    break;
  case "error":
    show(outcome.error.message);
    break;
  case "cancelled":
    break; // abort() or action.cancel()
}
```

`outcome.attempts` is the number of runs, retries included, when the dispatch ran itself. The callbacks and the plain result stay the main way to read a dispatch. Use `.outcome` where a call site needs the ending inline.

## Idempotency keys

`idempotencyKey: true` generates a key once per dispatch, and every retry of that dispatch reuses it. A function returns the key from the arguments. `run()` reads it as `ctx.idempotencyKey`.

- `apiAction` sends it in the `Idempotency-Key` header, exported as `IDEMPOTENCY_HEADER`.
- `transportAction` adds it to the command as `idempotency_key`, exported as `IDEMPOTENCY_COMMAND_FIELD`.

Import the two constants in a custom `run()` instead of copying the strings.

## Action names

Give every action a unique name, such as `items.delete`. A second definition with the same name logs one console warning, and the action log, `isPending`, `subscribeByName` and `bindLoadingState` then count both definitions as one. `dedupe` never joins dispatches across two definitions.
