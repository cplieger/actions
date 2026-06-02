// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));
import { defineAction, _resetForTest as resetDefine } from "./define.js";
import { _resetForTest as resetRegistry, recentLog } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";
import { configureTransport, transportAction, _resetTransportForTest } from "./transport.js";
import { ActionError, retryNetwork } from "./error.js";

const mockSend = vi.fn();

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
  _resetTransportForTest();
  vi.clearAllMocks();
  configureTransport(mockSend);
});

describe("runWithRetry: no retry on abort even for retry-class errors", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("signal aborted externally before run() throws — no retry", async () => {
    let attempts = 0;
    const action = defineAction<void, string>({
      name: "test.abort_no_retry",
      retryable: retryNetwork,
      retry: { count: 3, delay: 100 },
      error: false,
      run: async (_args, signal) => {
        attempts++;
        if (attempts === 1) {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                resolve();
              },
              { once: true },
            );
          });
          throw new ActionError("network error", { code: "network" });
        }
        return "should not reach";
      },
    });
    const p = action.dispatch();
    action.cancel();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await p;
    expect(result).toBeNull();
    expect(attempts).toBe(1);
    expect(recentLog()[0]?.status).toBe("cancelled");
  });
});

describe("transportAction: spread preserves type field", () => {
  it("idempotencyKey spread preserves the command type field", async () => {
    mockSend.mockResolvedValue({ ok: true, status: 200 });
    const action = transportAction<{ chatID: string }>({
      name: "test.type_preserved",
      idempotencyKey: true,
      command: ({ chatID }) => ({ type: "cancel" as const, chat_id: chatID }),
      error: false,
    });
    await action.dispatch({ chatID: "c1" });
    const sentCmd = mockSend.mock.calls[0]![0] as { type: string };
    expect(sentCmd.type).toBe("cancel");
  });
});
