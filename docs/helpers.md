# UI and polling helpers

This page covers the helpers around a dispatch, for developers who debounce input, poll a server, bind buttons to pending state, watch the action log or test code that uses actions.

## Debouncing input

`debouncedDispatch(action, { wait })` turns a burst of calls into one dispatch per `wait` window, for search as you type.

- By default every call restarts the timer and the last arguments win, so nothing is sent until the caller pauses for `wait` milliseconds.
- With `leading: true`, the first call dispatches at once, and calls inside the window are held for one dispatch when it closes.
- `flush(args?)` dispatches now with the latest arguments, or the ones given, and returns the action's promise. It does nothing when no call is waiting and no arguments are given.
- `cancel()` drops the waiting arguments. A dispatch already started is cancelled through the action or its handle.
- `isPending()` tells whether a call is waiting.

There is no `maxWait`. Call `flush()` when a dispatch must fire.

## Polling in the background

`pollAction(action, args, { interval })` dispatches the action repeatedly and returns a stop function.

- `interval` is the gap between one poll settling and the next starting, so a slow server never queues polls.
- Only one poll is in flight at a time. A tick that lands during a poll is dropped.
- `pauseWhenHidden`, on by default, pauses while the page is hidden. When the page is hidden at the start, the first poll waits until it is shown. Otherwise the first poll runs at once.
- `refreshOnFocus`, on by default, polls at once when the window gets focus.
- `backoffOnError: { factor, max }` stretches the gap by `factor` after each failed poll in a row, up to `max`. A poll fails when the dispatch resolves to `null`.
- `onSuccess(result)` fires for each result that is not `null`. A throw from it is logged and polling goes on.
- The stop function can be called more than once. It also runs on page unload.

Without a DOM, the pause and the focus refresh are skipped and the loop polls on a plain interval.

## Waiting for a terminal state

`pollUntil(step, options)` calls an async `step` until `until(result)` returns true, for a one-off wait such as a job that must finish. It waits `intervalMs` before every call, the first one included.

- `maxAttempts` and `timeoutMs` are separate budgets. When either runs out, the result is `{ status: "timeout" }` with no last call.
- A `step` that returns `null` or throws is a transient failure. The loop goes on, and `backoff: { factor, maxMs }` stretches the wait after consecutive failures.
- `signal` stops the loop with `{ status: "aborted" }`, which wins over a transient failure in the same round.
- `onPoll(result)` fires for each result that does not end the loop, and `onTransientError()` for each transient failure.
- The promise resolves to `{ status: "done", result }`, `{ status: "timeout" }` or `{ status: "aborted" }`. It rejects only when `until` throws.

## Loading state on a button

`bindLoadingState(names, element, options?)` disables a button, input, select or textarea while any of the named actions is pending, and returns a function that removes the binding.

- `names` is one action name or a list of them.
- `ariaBusy`, on by default, sets `aria-busy="true"` while pending. `preserveAriaBusy: true` leaves the attribute alone.
- `pendingClass` adds a CSS class while pending.
- When the action settles, the element is enabled again. `preserveDisabled: true` restores the disabled state it had before, and `disabledFn()` decides it instead.
- A focused element that was disabled gets its focus back when it is enabled again.
- The binding removes itself when a later change of pending state finds the element detached from the DOM. An element that is detached and attached again between two such changes, for example by a list that reuses nodes, keeps its binding.

## Button feedback

`withAsyncFeedback(button, fn, options?)` runs `fn` and shows its progress on the button. A spinner shows while it runs, then a check mark or a cross, then the original content.

- The button is disabled and marked `aria-busy` while `fn` runs. A second click during that time is ignored.
- A rejection from `fn` shows the cross. `withAsyncFeedback` itself always resolves.
- A screen reader hears "Action completed" or "Action failed". `announce: { success, error }` changes the text, and `announce: false` turns it off.
- `resetMs` is how long the outcome glyph stays, 1200 milliseconds by default. A value of 0 or less keeps the glyph, re-enables the button and leaves `data-async-status` on it.
- `keepLabel: true` puts the spinner before the label instead of replacing it.
- `target` runs the whole cycle on one child element, and leaves the label and other children alone.
- `renderPending`, `renderSuccess` and `renderError` return your own nodes in place of the default SVG glyphs.

## Watching actions

- `subscribeToActions(listener)` receives every state change of every action, and `subscribeByName(name, listener)` those of one action. Each returns an unsubscribe function.
- `getActionLog()` returns up to 1000 dispatches in flight plus the last 200 that settled, in dispatch order, for a debug panel.
- `isPending(name)` and `pendingCount(names?)` are reactive. Read inside a [`@cplieger/reactive`](https://github.com/cplieger/reactive) effect, they rerun the effect when the count changes.
- `registerCleanup(fn)` runs `fn` on page unload, beside the cancellation of every dispatch in flight. It returns a function that removes the hook.

The log keeps each dispatch's arguments in memory, and every listener receives them. Keep secrets, tokens and personal data out of action arguments. When more than 1000 dispatches are in flight at once, the oldest is dropped from the log with a console warning, because a dispatch that never settles usually means a bug.

## Running without a DOM

`bindLoadingState` and `withAsyncFeedback` read `document` and throw without a DOM. Everything else checks for `window` and `document` first, so in Node an action still defines, dispatches, retries and polls. Node skips three browser behaviors. A retry does not wait for the browser to come back online, `pollAction` neither pauses nor refreshes on focus, and nothing is cancelled on page unload.

## Testing

The `@cplieger/actions/testing` subpath exports `resetActionFramework()`. It returns the notifier, the HTTP and transport setup, the registered actions, the action log and the unload hooks to their first state, so one test's setup never leaks into the next. Import it from test code only.

```typescript
import { resetActionFramework } from "@cplieger/actions/testing";

beforeEach(() => {
  resetActionFramework();
});
```
