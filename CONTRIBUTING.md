# Contributing to actions

The [shared rules](https://github.com/cplieger/.github/blob/main/CONTRIBUTING.md) for commits, releases, synced files and checks apply here.

## Scope

The library ships no notification display and no streaming transport. An app connects its own through `configure` and `configureTransport`. A change that builds in a toast UI or a default transport is out of scope.

## Rules

- A runtime export that is added, renamed or removed needs three edits. Change it in `src/index.ts`, in its group in the README `## API` list, and on the `docs/` page for its topic.
- A module that keeps configuration or dispatch state at module level needs a test-only reset, and `resetActionFramework` in `src/testing.ts` must call it. `src/index.ts` never exports a reset. A missed reset leaks one test's setup into the next.
