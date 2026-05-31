/**
 * Shared action-test setup. Provides resetActionFramework() and mock factories.
 */
import { vi } from "vitest";

import { _resetForTest as resetDefine } from "../define.js";
import { _resetForTest as resetRegistry } from "../registry.js";
import { _resetForTest as resetCleanup } from "../cleanup.js";
import { _resetNotifierForTest as resetNotifier } from "../notifier.js";

/** Resets define, registry, cleanup, and notifier modules. Call in beforeEach(). */
export function resetActionFramework(): void {
  resetDefine();
  resetRegistry();
  resetCleanup();
  resetNotifier();
}

/** Canonical notifier mock factory for vi.mock("../notifier.js", mockNotifier) */
export const mockNotifier = () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
});
