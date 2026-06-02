// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));
import { defineAction, _resetForTest as resetDefine } from "./define.js";
import { _resetForTest as resetRegistry } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";
import { debouncedDispatch } from "./debounce.js";
import { configureTransport, transportAction, _resetTransportForTest } from "./transport.js";

const mockSend = vi.fn();

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
  _resetTransportForTest();
  vi.clearAllMocks();
  configureTransport(mockSend);
});

describe("dedupe + cancel interaction", () => {
  it("two concurrent dispatches with dedupe, then cancel — both resolve null", async () => {
    let runCalls = 0;
    const action = defineAction<{ id: string }, string>({
      name: "test.dedupe_cancel",
      dedupe: true,
      run: (_args, signal) => {
        runCalls++;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      },
    });
    const p1 = action.dispatch({ id: "a" });
    const p2 = action.dispatch({ id: "a" });
    expect(runCalls).toBe(1);
    action.cancel();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });
});

describe("debouncedDispatch leading + flush interaction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flush after leading fire dispatches the trailing args immediately", () => {
    const runArgs: string[] = [];
    const action = defineAction<string, void>({
      name: "test.leading_flush",
      run: (args) => {
        runArgs.push(args);
        return Promise.resolve();
      },
    });
    const dbg = debouncedDispatch(action, { wait: 100, leading: true });
    dbg("a");
    expect(runArgs).toEqual(["a"]);
    dbg("b");
    dbg.flush();
    expect(runArgs).toEqual(["a", "b"]);
  });
});

describe("transportAction idempotency_key interaction", () => {
  it("transportAction with idempotencyKey: true sends key in command", async () => {
    mockSend.mockResolvedValue({ ok: true, status: 200 });
    const action = transportAction<{ chatID: string }>({
      name: "test.transport_idem",
      idempotencyKey: true,
      command: ({ chatID }) => ({ type: "send", chat_id: chatID }),
      error: false,
    });
    await action.dispatch({ chatID: "c1" });
    const sentCmd = mockSend.mock.calls[0]![0] as { idempotency_key?: string };
    expect(sentCmd.idempotency_key).toEqual(expect.any(String));
  });
});

describe("per-call callbacks on deduped dispatches", () => {
  it("both callers' onSuccess fire with the same result", async () => {
    let resolveRun: ((v: string) => void) | undefined;
    const action = defineAction<string, string>({
      name: "test.dedupe_cb",
      dedupe: true,
      run: () =>
        new Promise<string>((r) => {
          resolveRun = r;
        }),
    });
    const onSuccess1 = vi.fn();
    const onSuccess2 = vi.fn();
    const p1 = action.dispatch("k", { onSuccess: onSuccess1 });
    const p2 = action.dispatch("k", { onSuccess: onSuccess2 });
    resolveRun!("shared");
    await Promise.all([p1, p2]);
    expect(onSuccess1).toHaveBeenCalledWith("shared", "k");
    expect(onSuccess2).toHaveBeenCalledWith("shared", "k");
  });
});
