import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetActionFramework } from "./test-helpers/action-test-setup.js";
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

  it("PUT sends rawBody verbatim with the caller's Content-Type (encoder seam)", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ status: "saved" }), { status: 200 }));
    const action = apiAction<string>({
      name: "test.raw_put",
      request: (yaml) => ({
        method: "PUT",
        path: "/api/config",
        rawBody: yaml,
        headers: { "Content-Type": "text/yaml" },
      }),
      error: "Failed",
    });
    await action.dispatch("providers:\n  enabled: true\n");
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe("/api/config");
    expect(opts.method).toBe("PUT");
    expect(opts.body).toBe("providers:\n  enabled: true\n");
    expect((opts.headers as Headers).get("content-type")).toBe("text/yaml");
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
    expect((opts.headers as Headers).get("content-type")).toBe("application/json");
    expect(opts.body).toBe(JSON.stringify({ name: "foo" }));
  });
});

describe("apiAction — unexpected empty body warning", () => {
  it("warns when a 200 response carries no body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
    const action = apiAction<undefined, unknown>({
      name: "test.empty_200",
      request: () => ({ method: "GET", path: "/api/thing" }),
      error: "Failed",
    });
    await action.dispatch(undefined);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("does not warn on a 204, whose empty body is expected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const action = apiAction<undefined, unknown>({
      name: "test.empty_204",
      request: () => ({ method: "GET", path: "/api/thing" }),
      error: "Failed",
    });
    await action.dispatch(undefined);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not warn on a DELETE, whose empty body is expected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
    const action = apiAction<undefined, unknown>({
      name: "test.empty_delete",
      request: () => ({ method: "DELETE", path: "/api/thing" }),
      error: "Failed",
    });
    await action.dispatch(undefined);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not warn when the response carries a body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ name: "foo" }), { status: 200 }));
    const action = apiAction<undefined, unknown>({
      name: "test.nonempty_200",
      request: () => ({ method: "GET", path: "/api/thing" }),
      error: "Failed",
    });
    await action.dispatch(undefined);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("apiAction — a def timeout aborts the run signal but not the dispatch", () => {
  // def.timeout aborts the caller signal fetch sees while the dispatch's own
  // AbortSignal stays live, so define.ts classifies it as an ERROR. The only
  // path that observes api.ts's `code === "cancelled"` arm.
  it("surfaces fetch's cancelled envelope as a status-less error coded 'cancelled'", async () => {
    mockFetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    const onError = vi.fn();
    const action = apiAction<{ id: string }, { name: string }>({
      name: "test.def_timeout_cancelled",
      timeout: 20,
      request: ({ id }) => ({ method: "GET", path: `/api/items/${id}` }),
      error: false,
      onError,
    });

    const handle = action.dispatch({ id: "1" });

    await expect(handle.outcome).resolves.toEqual({
      status: "error",
      error: { message: "Request cancelled", code: "cancelled" },
      attempts: 1,
    });
    expect(onError).toHaveBeenCalledWith(
      { message: "Request cancelled", code: "cancelled" },
      { id: "1" },
    );
    const log = recentLog()[0];
    expect(log?.status).toBe("error");
    expect(log?.error?.code).toBe("cancelled");
    expect(log?.error?.status).toBeUndefined();
  });
});

describe("apiAction — a request that never reached the network", () => {
  it("maps an un-encodable body to a status-less invalid error, so retryNetwork will not retry it", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const action = apiAction<undefined, unknown>({
      name: "test.unencodable_body",
      request: () => ({ method: "POST", path: "/api/items", body: { n: 10n } as never }),
      error: false,
    });
    const result = await action.dispatch(undefined);
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    const err = recentLog()[0]?.error;
    expect(err?.code).toBe("invalid");
    expect(err?.status).toBeUndefined();
  });
});
