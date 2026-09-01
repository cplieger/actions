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
