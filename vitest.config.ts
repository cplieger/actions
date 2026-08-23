// Vitest configuration for @cplieger/actions unit tests.
//
// Two projects, and the DEFAULT is the browser. A test file runs in a real
// headless Chromium unless its name opts out, because the browser is the
// environment this library actually ships into and a DOM emulator got several
// of these assertions wrong for free.
//
// The opt-out is the `.node.test.ts` suffix, and it is load-bearing rather than
// decorative: placement has to be readable off the filename because one of the
// two reasons a file needs Node fails SILENTLY when it is misplaced.
//
//   - A test that needs Node capabilities (reading a fixture with `node:fs`)
//     throws on the import when it lands in the browser. Loud, self-correcting.
//   - A test that needs browser globals to be ABSENT does not. It passes
//     vacuously, having exercised the arm it was written to avoid.
//     `poll-no-dom.node.test.ts` is that case: it is the only thing pinning
//     poll.ts's `typeof document === "undefined"` guards, and in a browser
//     those branches are unreachable. Enumerating such files in this config
//     instead of naming them would let the list drift undetected.
//
// So the reason lives in the stem (`poll-no-dom`) and the placement in the
// suffix (`.node`). Fuzz keeps its own axis: `*.fuzz.test.ts` is how ts-ci
// selects fuzz targets, and a DOM fuzz test needs no marker here at all.
//
// `channel: "chromium"` opts into Chromium's newer headless mode, the real
// browser rather than the separate headless-shell build. CI installs it with
// `npx playwright install --with-deps chromium`; locally it is a one-time
// `npx --no-install playwright install chromium`.
//
// Run: vitest --run (single pass) or vitest (watch mode)
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `extends: true` on every project is REQUIRED, not decorative: a project
    // inherits NOTHING from the block below without it, and losing a strictness
    // option (expect.requireAssertions, allowOnly, mockReset, unstubGlobals, the
    // timeouts) never fails a test, so the suite would go green while the bar
    // dropped. It is a SIBLING of `test`, not a key inside it: spelled
    // `test: { extends: true }` it type-checks, runs, and inherits nothing.
    // Verified the only way that means anything, by dropping a zero-assertion
    // probe test into each project: with `extends: true` both FAIL under
    // requireAssertions, and with the key moved inside `test` both PASS.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.node.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.node.test.ts", "node_modules/**"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({
              launchOptions: {
                channel: "chromium",
              },
            }),
            instances: [{ browser: "chromium" }],
            viewport: { width: 1280, height: 720 },
            // A failure screenshot per failing test is noise in CI and cannot
            // be read from a job log; the assertion diff is the artifact.
            screenshotFailures: false,
          },
        },
      },
    ],
    // No `include` at this level. `extends: true` MERGES array options, so a
    // root include would leak into the node project and make it collect every
    // browser test; each project declares its own.
    passWithNoTests: false,
    allowOnly: false,
    globals: false,
    expect: {
      requireAssertions: true,
    },
    // clearMocks: call history. mockReset: history + implementations.
    // restoreMocks: vi.spyOn originals. unstubEnvs/unstubGlobals: vi.stubEnv
    // and vi.stubGlobal. Together they stop one test's double reaching the next.
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    bail: process.env["CI"] ? 1 : 0,
    testTimeout: 5000,
    hookTimeout: 10000,
    // Root-only in vitest 4: a per-project slowTestThreshold is not read.
    slowTestThreshold: 300,
    sequence: {
      shuffle: { files: false, tests: false },
      concurrent: false,
      hooks: "stack",
    },
    printConsoleTrace: true,
    expandSnapshotDiff: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/test-helpers/**"],
      reportOnFailure: true,
      reporter: ["text", "text-summary", "lcov"],
    },
    chaiConfig: {
      truncateThreshold: 0,
      showDiff: true,
      includeStack: true,
    },
  },
});
