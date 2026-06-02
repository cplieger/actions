// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetActionFramework } from "./__test-helpers__/action-test-setup.js";
vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));
import { apiAction } from "./api.js";
import { recentLog } from "./registry.js";

const mockFetch = vi.fn();

beforeEach(() => {
  resetActionFramework();
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const testAction = () =>
  apiAction<{ id: string }, { name: string }>({
    name: "test.api",
    request: ({ id }) => ({ method: "GET", path: `/api/items/${id}` }),
    error: "Test failed",
  });

describe("apiAction", () => {
  it("returns parsed JSON on 200", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ name: "foo" }), { status: 200 }));
    const action = testAction();
    const result = await action.dispatch({ id: "1" });
    expect(result).toEqual({ name: "foo" });
    expect(recentLog()[0]?.status).toBe("success");
  });

  it("returns undefined on 204 (no JSON parse)", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const action = testAction();
    const result = await action.dispatch({ id: "1" });
    expect(result).toBeUndefined();
  });

  it("throws ActionError with code 'timeout' on TimeoutError DOMException", async () => {
    mockFetch.mockRejectedValue(new DOMException("The operation timed out", "TimeoutError"));
    const action = testAction();
    const result = await action.dispatch({ id: "1" });
    expect(result).toBeNull();
    expect(recentLog()[0]?.error?.code).toBe("timeout");
  });

  it("throws ActionError with code 'cancelled' on AbortError when signal.aborted", async () => {
    mockFetch.mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));
    const action = testAction();
    const promise = action.dispatch({ id: "1" });
    action.cancel();
    await promise;
    expect(recentLog()[0]?.status).toBe("cancelled");
  });

  it("throws ActionError with code 'network' on TypeError (Failed to fetch)", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const action = testAction();
    await action.dispatch({ id: "1" });
    expect(recentLog()[0]?.error?.code).toBe("network");
  });

  it("throws ActionError with status + body.error message on non-OK response", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );
    const action = testAction();
    await action.dispatch({ id: "1" });
    const log = recentLog()[0];
    expect(log?.error?.status).toBe(404);
    expect(log?.error?.message).toBe("Not found");
  });

  it("POST sends JSON body with Content-Type header", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const action = apiAction<{ name: string }>({
      name: "test.post",
      request: ({ name }) => ({ method: "POST", path: "/api/items", body: { name } }),
      error: "Failed",
    });
    await action.dispatch({ name: "foo" });
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe("/api/items");
    expect(opts.method).toBe("POST");
    expect(opts.headers).toEqual({ "content-type": "application/json" });
    expect(opts.body).toBe(JSON.stringify({ name: "foo" }));
  });
});
