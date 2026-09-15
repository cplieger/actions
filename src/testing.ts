/**
 * Test-only resets for the framework's module-global state.
 *
 * Published as the `@cplieger/actions/testing` subpath so a suite can return
 * the notifier, api, transport, define, registry and cleanup slots to their
 * unconfigured state between cases; without that, one test's `configure*()`
 * call and its registered actions leak into the next. Import it from test code
 * only: in an application the slots are set once at boot, and clearing them at
 * runtime drops the adapters every dispatch depends on.
 *
 * @module
 */

import { _resetForTest as resetDefine } from "./define.js";
import { _resetForTest as resetRegistry } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";
import { _resetApiConfigForTest as resetApi } from "./api.js";
import { _resetTransportForTest as resetTransport } from "./transport.js";
import { _resetNotifierForTest as resetNotifier } from "./notifier.js";

/** Reset every framework state slot. Call from `beforeEach()`. */
export function resetActionFramework(): void {
  resetDefine();
  resetRegistry();
  resetCleanup();
  resetApi();
  resetTransport();
  resetNotifier();
}
