/**
 * Test-only utilities.
 *
 * Public subpath: `import { resetActionFramework } from "@cplieger/actions/testing"`.
 *
 * Replaces the previously-undocumented internal deep-imports
 * (`_resetForTest` / `_resetApiConfigForTest` / `_resetTransportForTest` /
 * `_resetNotifierForTest`) from `src/{define,registry,cleanup,api,transport,notifier}.ts`.
 *
 * Intended for consumer test suites that need to clear all framework state
 * between tests. NOT for use in production code.
 */

import { _resetForTest as resetDefine } from "./define.js";
import { _resetForTest as resetRegistry } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";
import { _resetApiConfigForTest as resetApi } from "./api.js";
import { _resetTransportForTest as resetTransport } from "./transport.js";
import { _resetNotifierForTest as resetNotifier } from "./notifier.js";

/**
 * Reset every framework state slot — define, registry, cleanup, api,
 * transport, notifier. Call from `beforeEach()` in test suites.
 */
export function resetActionFramework(): void {
  resetDefine();
  resetRegistry();
  resetCleanup();
  resetApi();
  resetTransport();
  resetNotifier();
}
