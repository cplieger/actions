/**
 * Shared action-test setup. Provides resetActionFramework() and mock factories.
 */
import { vi } from "vitest";

import { _resetForTest as resetDefine } from "../define.js";
import { _resetForTest as resetRegistry } from "../registry.js";
import { _resetForTest as resetCleanup } from "../cleanup.js";
import { _resetNotifierForTest as resetNotifier } from "../notifier.js";
import { _resetTransportForTest as resetTransport } from "../transport.js";

/** Resets define, registry, cleanup, notifier, and transport modules. Call in beforeEach(). */
export function resetActionFramework(): void {
  resetDefine();
  resetRegistry();
  resetCleanup();
  resetNotifier();
  resetTransport();
}

/** Canonical notifier mock factory for vi.mock("../notifier.js", mockNotifier) */
export const mockNotifier = () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
});

/** Canonical transport mock factory for vi.mock("../transport.js", mockTransport) */
export const mockTransport = () => ({
  configureTransport: vi.fn(),
  transportAction: vi.fn(),
  _resetTransportForTest: vi.fn(),
});
