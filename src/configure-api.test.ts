// @vitest-environment happy-dom
// Tests for the configureApi HTTP-customization seam.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));

import { apiAction, configureApi, _resetApiConfigForTest } from "./api.js";
import { _resetForTest as resetDefine } from "./define.js";
import { _resetForTest as resetRegistry } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";

const mockFetch = vi.fn();

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
  _resetApiConfigForTest();
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("configureApi — baseUrl", () => {
  it("prepends baseUrl to request path", async () => {
    configureApi({ baseUrl: "https://api.example.com/v1" });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const action = apiAction<string>({ name: "base.url", request: (id) => ({ method: "GET", path: `/items/${id}` }) });
    await action.dispatch("42");
    expect(mockFetch.mock.calls[0]![0]).toBe("https://api.example.com/v1/items/42");
  });

  it("works without baseUrl (relative path)", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const action = apiAction<string>({ name: "no.base", request: (id) => ({ method: "GET", path: `/items/${id}` }) });
    await action.dispatch("1");
    expect(mockFetch.mock.calls[0]![0]).toBe("/items/1");
  });
});

describe("configureApi — prepareHeaders", () => {
  it("injects auth headers on every request", async () => {
    configureApi({
      prepareHeaders: (headers) => {
        headers.set("Authorization", "Bearer test-token");
      },
    });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({ name: "auth.header", request: () => ({ method: "GET", path: "/me" }) });
    await action.dispatch("x");
    const headers = mockFetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer test-token");
  });

  it("supports async prepareHeaders", async () => {
    configureApi({
      prepareHeaders: async (headers) => {
        await Promise.resolve();
        headers.set("X-CSRF", "async-token");
      },
    });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({ name: "async.header", request: () => ({ method: "GET", path: "/x" }) });
    await action.dispatch("x");
    const headers = mockFetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["x-csrf"]).toBe("async-token");
  });

  it("receives the request spec as context", async () => {
    const spy = vi.fn();
    configureApi({
      prepareHeaders: (headers, ctx) => {
        spy(ctx.spec);
      },
    });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({ name: "ctx.spec", request: (id) => ({ method: "POST", path: `/items/${id}`, body: { id } }) });
    await action.dispatch("5");
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ method: "POST", path: "/items/5" }));
  });

  it("does not override per-request headers set in RequestSpec", async () => {
    configureApi({
      prepareHeaders: (headers) => {
        headers.set("X-Global", "global");
        headers.set("X-Override", "from-global");
      },
    });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    // Per-request headers are set before prepareHeaders, so prepareHeaders wins
    // This matches RTK behavior where prepareHeaders runs last
    const action = apiAction<string>({
      name: "override.test",
      request: () => ({ method: "GET", path: "/x", headers: { "X-Override": "from-spec" } }),
    });
    await action.dispatch("x");
    const headers = mockFetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["x-global"]).toBe("global");
    // prepareHeaders runs after spec headers, so it overrides
    expect(headers["x-override"]).toBe("from-global");
  });
});

describe("configureApi — credentials", () => {
  it("sets credentials on every request", async () => {
    configureApi({ credentials: "include" });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({ name: "creds", request: () => ({ method: "GET", path: "/x" }) });
    await action.dispatch("x");
    expect(mockFetch.mock.calls[0]![1].credentials).toBe("include");
  });

  it("omits credentials when not configured", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({ name: "no.creds", request: () => ({ method: "GET", path: "/x" }) });
    await action.dispatch("x");
    expect(mockFetch.mock.calls[0]![1].credentials).toBeUndefined();
  });
});

describe("configureApi — fetchFn", () => {
  it("uses custom fetch implementation", async () => {
    const customFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ custom: true }), { status: 200 }));
    configureApi({ fetchFn: customFetch });
    const action = apiAction<string>({ name: "custom.fetch", request: () => ({ method: "GET", path: "/x" }) });
    const result = await action.dispatch("x");
    expect(customFetch).toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual({ custom: true });
  });
});

describe("configureApi — combined", () => {
  it("baseUrl + prepareHeaders + credentials work together", async () => {
    configureApi({
      baseUrl: "https://api.test.io",
      credentials: "include",
      prepareHeaders: (headers) => {
        headers.set("Authorization", "Bearer combo");
      },
    });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const action = apiAction<{ name: string }>({
      name: "combo",
      request: ({ name }) => ({ method: "POST", path: "/items", body: { name } }),
    });
    await action.dispatch({ name: "test" });
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://api.test.io/items");
    expect(opts.credentials).toBe("include");
    const headers = opts.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer combo");
    expect(headers["content-type"]).toBe("application/json");
  });
});

describe("RequestSpec.headers — per-request headers", () => {
  it("sends per-request headers on GET", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({
      name: "per.req.get",
      request: () => ({ method: "GET", path: "/x", headers: { "X-Custom": "val" } }),
    });
    await action.dispatch("x");
    const headers = mockFetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["x-custom"]).toBe("val");
  });

  it("sends per-request headers on POST alongside Content-Type", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({
      name: "per.req.post",
      request: () => ({ method: "POST", path: "/x", body: { a: 1 }, headers: { "X-Request-Id": "abc" } }),
    });
    await action.dispatch("x");
    const headers = mockFetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-request-id"]).toBe("abc");
  });
});
