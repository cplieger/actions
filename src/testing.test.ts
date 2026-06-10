// @vitest-environment happy-dom
// Tests for the public ./testing subpath — verifies resetActionFramework()
// clears every state slot (define, registry, cleanup, api, transport, notifier).
import { describe, it, expect, vi, beforeEach } from "vitest";

import { resetActionFramework } from "./testing.js";
import { defineAction } from "./define.js";
import { configure } from "./notifier.js";
import { apiAction, configureApi } from "./api.js";
import { configureTransport, transportAction } from "./transport.js";
import { getActionLog, pendingCount } from "./registry.js";
import { registerCleanup, _cancelAllForTest as cancelAll } from "./cleanup.js";

beforeEach(() => {
  resetActionFramework();
  vi.clearAllMocks();
});

describe("resetActionFramework", () => {
  it("clears the registry log and pending count", async () => {
    const a = defineAction({
      name: "reset.registry",
      run: async () => 1,
    });
    await a.dispatch(undefined);

    expect(getActionLog().length).toBeGreaterThan(0);

    resetActionFramework();

    expect(getActionLog()).toEqual([]);
    expect(pendingCount()).toBe(0);
  });

  it("clears the configured notifier", async () => {
    const successSpy = vi.fn();
    configure({ success: successSpy });

    const a = defineAction({
      name: "reset.notifier",
      run: async () => "ok",
      success: "Done",
    });
    await a.dispatch(undefined);
    expect(successSpy).toHaveBeenCalledTimes(1);

    resetActionFramework();

    const b = defineAction({
      name: "reset.notifier.after",
      run: async () => "ok",
      success: "Done2",
    });
    await b.dispatch(undefined);

    // Notifier reset → previously-configured success spy must not fire again.
    expect(successSpy).toHaveBeenCalledTimes(1);
  });

  it("clears the configured transport (transportAction throws after reset)", async () => {
    configureTransport(async () => ({ ok: true, status: 200 }));

    resetActionFramework();

    const a = transportAction<{ id: string }>({
      name: "reset.transport",
      command: ({ id }) => ({ type: "noop", id }),
    });

    await a.dispatch({ id: "x" });
    const log = getActionLog();
    expect(log.length).toBeGreaterThan(0);
    const last = log[log.length - 1];
    expect(last?.status).toBe("error");
    expect(last?.error?.code).toBe("transport_not_configured");
  });

  it("clears the configured api baseUrl/fetchFn", async () => {
    const customFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }),
    );
    configureApi({
      baseUrl: "https://api.example.com",
      fetchFn: customFetch as unknown as typeof fetch,
    });

    resetActionFramework();

    const globalFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const a = apiAction<void, unknown>({
      name: "reset.api",
      request: () => ({ method: "GET", path: "/items" }),
    });
    await a.dispatch(undefined);

    // Reset → custom fetchFn no longer used.
    expect(customFetch).not.toHaveBeenCalled();
    // Reset → global fetch invoked with relative path (no baseUrl prefix).
    expect(globalFetch).toHaveBeenCalledTimes(1);
    const callArg = globalFetch.mock.calls[0]?.[0];
    const url = typeof callArg === "string" ? callArg : (callArg as Request).url;
    expect(url).toContain("/items");
    expect(url).not.toContain("api.example.com");

    globalFetch.mockRestore();
  });

  it("clears registered cleanup hooks", () => {
    const hook = vi.fn();
    registerCleanup(hook);

    resetActionFramework();

    cancelAll();

    expect(hook).not.toHaveBeenCalled();
  });

  it("is idempotent (safe to call repeatedly)", () => {
    expect(() => {
      resetActionFramework();
      resetActionFramework();
      resetActionFramework();
    }).not.toThrow();
  });
});
