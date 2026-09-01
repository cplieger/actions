import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetActionFramework } from "./test-helpers/action-test-setup.js";
import { configureTransport, transportAction, _resetTransportForTest } from "./transport.js";
import { recentLog } from "./registry.js";

vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));

const mockSend = vi.fn();

beforeEach(() => {
  resetActionFramework();
  vi.clearAllMocks();
  mockSend.mockReset();
  configureTransport(mockSend);
});

const testAction = () =>
  transportAction<{ chatID: string }>({
    name: "test.transport",
    command: ({ chatID }) => ({ type: "cancel", chat_id: chatID }),
    error: "Test failed",
  });

describe("transportAction error classification", () => {
  it("classifies timeout via r.code", async () => {
    mockSend.mockResolvedValue({
      ok: false,
      status: 0,
      error: "Request timed out",
      code: "timeout",
    });
    const action = testAction();
    await action.dispatch({ chatID: "c1" });
    const log = recentLog();
    expect(log[0]?.status).toBe("error");
    expect(log[0]?.error?.code).toBe("timeout");
  });

  it("classifies cancelled via r.code", async () => {
    mockSend.mockResolvedValue({
      ok: false,
      status: 0,
      error: "Request cancelled",
      code: "cancelled",
    });
    const action = testAction();
    await action.dispatch({ chatID: "c1" });
    const log = recentLog();
    expect(log[0]?.status).toBe("error");
    expect(log[0]?.error?.code).toBe("cancelled");
  });

  it("classifies network error via r.code", async () => {
    mockSend.mockResolvedValue({ ok: false, status: 0, error: "Failed to fetch", code: "network" });
    const action = testAction();
    await action.dispatch({ chatID: "c1" });
    const log = recentLog();
    expect(log[0]?.status).toBe("error");
    expect(log[0]?.error?.code).toBe("network");
  });

  it("HTTP errors without code throw with status only", async () => {
    mockSend.mockResolvedValue({ ok: false, status: 500, error: "Internal Server Error" });
    const action = testAction();
    await action.dispatch({ chatID: "c1" });
    const log = recentLog();
    expect(log[0]?.status).toBe("error");
    expect(log[0]?.error?.status).toBe(500);
    expect(log[0]?.error?.code).toBeUndefined();
  });

  it("signal.aborted takes precedence", async () => {
    mockSend.mockImplementation(async (_cmd, { signal }) => {
      await new Promise((r) => setTimeout(r, 10));
      if (signal.aborted) return { ok: false, status: 0, error: "cancelled", code: "network" };
      return { ok: true, status: 200 };
    });
    const action = testAction();
    const promise = action.dispatch({ chatID: "c1" });
    action.cancel();
    await promise;
    const log = recentLog();
    expect(log[0]?.status).toBe("cancelled");
  });
});

describe("transportAction — unconfigured transport", () => {
  it("throws ActionError with code transport_not_configured when transport is not set", async () => {
    _resetTransportForTest();
    const action = transportAction<{ id: string }>({
      name: "test.no_transport",
      command: ({ id }) => ({ type: "test", id }),
      error: false,
    });
    const result = await action.dispatch({ id: "x" });
    expect(result).toBeNull();
    const log = recentLog();
    expect(log[0]?.error?.code).toBe("transport_not_configured");
  });
});

describe("transportAction — a successful send", () => {
  it("resolves with the action's success outcome and does not throw", async () => {
    mockSend.mockResolvedValue({ ok: true, status: 200 });
    const action = testAction();
    const result = await action.dispatch({ chatID: "c1" });
    expect(result).toBeUndefined();
    expect(recentLog()[0]?.status).toBe("success");
    expect(recentLog()[0]?.error).toBeUndefined();
  });
});

describe("transportAction — error classification defaults", () => {
  it("reports a cancelled result as cancelled even when the signal never aborted", async () => {
    mockSend.mockResolvedValue({ ok: false, status: 0, code: "cancelled" });
    const action = testAction();
    await action.dispatch({ chatID: "c1" });
    const err = recentLog()[0]?.error;
    expect(err?.code).toBe("cancelled");
    expect(err?.message).toBe("cancelled");
    expect(err?.status).toBeUndefined();
  });

  it("supplies the default timeout message when the transport sends none", async () => {
    mockSend.mockResolvedValue({ ok: false, status: 504, code: "timeout" });
    const action = testAction();
    await action.dispatch({ chatID: "c1" });
    const err = recentLog()[0]?.error;
    expect(err?.code).toBe("timeout");
    expect(err?.message).toBe("Request timed out");
    expect(err?.status).toBe(504);
  });

  it("supplies the default network message when the transport sends none", async () => {
    mockSend.mockResolvedValue({ ok: false, status: 0, code: "network" });
    const action = testAction();
    await action.dispatch({ chatID: "c1" });
    const err = recentLog()[0]?.error;
    expect(err?.code).toBe("network");
    expect(err?.message).toBe("network error");
    expect(err?.status).toBe(0);
  });

  it("passes a server-supplied code through on an HTTP failure", async () => {
    mockSend.mockResolvedValue({
      ok: false,
      status: 422,
      error: "name already taken",
      code: "validation_failed",
    });
    const action = testAction();
    await action.dispatch({ chatID: "c1" });
    const err = recentLog()[0]?.error;
    expect(err?.code).toBe("validation_failed");
    expect(err?.message).toBe("name already taken");
    expect(err?.status).toBe(422);
  });
});

describe("transportAction — idempotency key", () => {
  it("adds idempotency_key to command when configured", async () => {
    mockSend.mockResolvedValue({ ok: true, status: 200 });
    const action = transportAction<{ chatID: string }>({
      name: "test.idem_transport",
      idempotencyKey: true,
      command: ({ chatID }) => ({ type: "cancel", chat_id: chatID }),
      error: false,
    });
    await action.dispatch({ chatID: "c1" });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const sentCmd = mockSend.mock.calls[0]![0] as { idempotency_key?: string };
    expect(sentCmd.idempotency_key).toEqual(expect.any(String));
  });

  it("dispatching with a frozen command object does NOT throw", async () => {
    mockSend.mockResolvedValue({ ok: true, status: 200 });
    const frozenCmd = Object.freeze({ type: "cancel" as const, chat_id: "c1" });
    const action = transportAction<void>({
      name: "test.frozen_cmd",
      idempotencyKey: true,
      command: () => frozenCmd,
      error: "Frozen failed",
    });
    await action.dispatch(undefined);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const sent = mockSend.mock.calls[0]![0] as { idempotency_key?: string };
    expect(sent.idempotency_key).toEqual(expect.any(String));
  });
});
