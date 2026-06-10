/**
 * Internal test setup — re-exports `resetActionFramework` from the public
 * `./testing` entrypoint so internal tests share the canonical implementation.
 *
 * Also provides canonical `vi.mock()` factories for the notifier and transport
 * modules (used by tests that want to assert calls without exercising the
 * real adapters).
 */
import { vi } from "vitest";

export { resetActionFramework } from "../testing.js";

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
