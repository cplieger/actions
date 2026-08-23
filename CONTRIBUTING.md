# Contributing to actions

`@cplieger/actions` is a dependency-light, vanilla-TypeScript library
published to both npm and JSR. This guide covers the bits that aren't
obvious from reading the source. For org-wide defaults not repeated here,
see the [fallback contributing guide](https://github.com/cplieger/.github/blob/main/CONTRIBUTING.md).

## Architecture

The framework is a set of small, single-purpose modules under `src/`, each
paired with a colocated `*.test.ts`:

- `define.ts` (+ `define-helpers.ts`): `defineAction`, the lifecycle runner
  (optimistic → run → retry → notify → rollback). This is the core.
- `api.ts`: `apiAction` / `configureApi`, the HTTP layer (a private
  [`@cplieger/fetch`](https://github.com/cplieger/fetch) instance).
- `transport.ts`: `transportAction` / `configureTransport` for SSE/streaming.
- `notifier.ts`: `configure`, the injected success/error notification adapter.
- `registry.ts`: the observability log plus the reactive `isPending` /
  `pendingCount` signals.
- `loading.ts`, `async-feedback.ts`, `debounce.ts`, `poll.ts`,
  `poll-until.ts`, `cleanup.ts`, `retry.ts`, `error.ts`: focused helpers.
- `types.ts`: pure types, no imports, no runtime. Any module may depend on it.

The only runtime dependencies are
[`@cplieger/reactive`](https://github.com/cplieger/reactive), which backs the
pending-state signals (`bindLoadingState` is just an effect over them), and
`@cplieger/fetch`, which `api.ts` wraps.

Three adapters are injected by the consumer, never hard-wired: the notifier
(`configure`), the HTTP layer (`configureApi`), and the streaming transport
(`configureTransport`). Keep it that way: the library must not assume a
toast implementation or a fetch wrapper.

## Public API surface

`src/index.ts` is the entire public surface; `src/testing.ts` is the separate
`@cplieger/actions/testing` subpath. Both are wired into `package.json`
`exports` and `jsr.json` `exports`.

- Anything new that consumers should reach must be re-exported from
  `src/index.ts` (and `package.json` `types`/`exports` already point there).
- Test-only helpers go through `src/testing.ts`. The old
  `@cplieger/actions/src/*` deep-import escape hatch was removed in v2.0; do
  not reintroduce per-module `_resetForTest` exports as a public path.
- The README documents the API; update its `## API` list when you add,
  rename, or remove an export.

## Local development

Install dev dependencies, then run the checks (scripts are in `package.json`):

```sh
npm install
npm run typecheck         # tsc -project tsconfig.json (source)
npm run typecheck:tests   # tsc -project tsconfig.test.json (incl. tests)
npm test                  # vitest --run
npx eslint .              # strict typed lint (eslint.config.mjs)
```

There is no build step to run locally: the package ships TypeScript source
directly (both npm and JSR reference `src/**/*.ts`), so consumers compile it
through their own bundler. The `dist` `outDir` in `tsconfig.json` only backs
declaration emit and is not published.

## Conventions and gotchas

- **`.js` import extensions in TypeScript.** Relative imports use a `.js`
  suffix (e.g. `import { record } from "./registry.js"`) even though the
  files are `.ts`. This is required by the `"moduleResolution": "bundler"`
  ESM setup; matching the existing style is mandatory or the build breaks.
- **Strict compiler.** `tsconfig.json` enables `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`,
  `noImplicitOverride`, and friends. Expect to handle `undefined` explicitly.
- **Strict typed ESLint.** `eslint.config.mjs` runs the `strictTypeChecked`
  and `stylisticTypeChecked` presets: no `any` (prefer `unknown`), inline
  `import type`, `eqeqeq`, `curly`, `prefer-const`. Prefix deliberately
  unused names with `_`.
- **Tests are colocated** as `src/**/*.test.ts` (the only pattern vitest
  includes). Reset all framework state between tests with
  `resetActionFramework()` from `@cplieger/actions/testing` in `beforeEach`,
  since module singletons (registry, notifier, api/transport config) persist
  otherwise.
- **A test runs in a real headless Chromium unless its name opts out.** The
  opt-out is the `.node.test.ts` suffix, which puts a file in the `node`
  project. Use it only for a test that genuinely needs Node: one that reads a
  fixture off disk, or one whose subject is the ABSENCE of browser globals.
  `poll-no-dom.node.test.ts` is the second kind, and it is the reason the suffix
  is a filename rather than a list in `vitest.config.ts`: a fixture reader that
  lands in the browser throws on its `node:` import and fixes itself, while a
  DOM-absence test passes vacuously, having exercised the arm it was written to
  avoid. Put the reason in the stem and the placement in the suffix.
- **Do not simulate what the browser does.** A disabled element loses focus to
  `<body>` on its own, transitions really fire, and boxes really have size.
  Assert the behavior; helpers that faked it under the previous DOM emulator
  have been removed.
- **Property tests.** `fast-check` drives the invariant-style coverage; keep new
  invariants in that idiom where they fit.
- **Don't edit `.github/workflows/*`.** `ci.yaml` and `release.yaml` are
  synced from `cplieger/ci` and marked DO NOT EDIT; behavior changes belong
  upstream.

## Publishing

Releases are automated. A push to `main` runs the centralized release
workflow, which computes the next version from commit history via git-cliff
and publishes to both npm and JSR. Keep `version` in `package.json` and
`jsr.json` consistent; never hand-cut a release locally.

## Commits and PRs

Branch from `main`, keep changes focused with tests, and open a PR.
Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
parsed by git-cliff: `feat:` → minor, `fix:`/`sec:` → patch/security,
`feat!:` or `BREAKING CHANGE:` → major, and `chore`/`ci`/`docs`/`test`/
`style`/`refactor` don't trigger a release (see `cliff.toml`). Renovate
devDependency bumps use `chore(devdeps)` and are intentionally skipped.

## Conduct & security

By participating you agree to the
[Code of Conduct](https://github.com/cplieger/.github/blob/main/CODE_OF_CONDUCT.md).
Report vulnerabilities through the
[security policy](https://github.com/cplieger/.github/blob/main/SECURITY.md),
never in a public issue.
