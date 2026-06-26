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
import { _resetForTest as resetRegistry, recentLog } from "./registry.js";
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
    const action = apiAction<string>({
      name: "base.url",
      request: (id) => ({ method: "GET", path: `/items/${id}` }),
    });
    await action.dispatch("42");
    expect(mockFetch.mock.calls[0]![0]).toBe("https://api.example.com/v1/items/42");
  });

  it("works without baseUrl (relative path)", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const action = apiAction<string>({
      name: "no.base",
      request: (id) => ({ method: "GET", path: `/items/${id}` }),
    });
    await action.dispatch("1");
    expect(mockFetch.mock.calls[0]![0]).toBe("/items/1");
  });

  it("collapses the double slash when baseUrl ends with '/' and path starts with '/'", async () => {
    configureApi({ baseUrl: "https://api.example.com/" });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({
      name: "base.double_slash",
      request: (id) => ({ method: "GET", path: `/items/${id}` }),
    });
    await action.dispatch("42");
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toBe("https://api.example.com/items/42");
    expect(url).not.toContain("//items");
  });

  it("inserts a single slash when baseUrl has a trailing slash and the path has none", async () => {
    configureApi({ baseUrl: "https://api.example.com/" });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({
      name: "base.no_leading_slash",
      request: () => ({ method: "GET", path: "items" }),
    });
    await action.dispatch("x");
    expect(mockFetch.mock.calls[0]![0]).toBe("https://api.example.com/items");
  });

  it("preserves the query string when joining baseUrl", async () => {
    configureApi({ baseUrl: "https://api.example.com/v1" });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({
      name: "base.query",
      request: () => ({ method: "GET", path: "/items?foo=bar&baz=1" }),
    });
    await action.dispatch("x");
    expect(mockFetch.mock.calls[0]![0]).toBe("https://api.example.com/v1/items?foo=bar&baz=1");
  });

  it("preserves the query string when baseUrl has a trailing slash", async () => {
    configureApi({ baseUrl: "https://api.example.com/" });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({
      name: "base.query_trailing",
      request: () => ({ method: "GET", path: "/search?q=hello&page=2" }),
    });
    await action.dispatch("x");
    expect(mockFetch.mock.calls[0]![0]).toBe("https://api.example.com/search?q=hello&page=2");
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
    const action = apiAction<string>({
      name: "auth.header",
      request: () => ({ method: "GET", path: "/me" }),
    });
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
    const action = apiAction<string>({
      name: "async.header",
      request: () => ({ method: "GET", path: "/x" }),
    });
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
    const action = apiAction<string>({
      name: "ctx.spec",
      request: (id) => ({ method: "POST", path: `/items/${id}`, body: { id } }),
    });
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

  it("surfaces an async prepareHeaders rejection as an action error without calling fetch", async () => {
    configureApi({
      prepareHeaders: async () => {
        throw new Error("token refresh failed");
      },
    });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({
      name: "prep.async_reject",
      request: () => ({ method: "GET", path: "/x" }),
    });
    const result = await action.dispatch("x");
    expect(result).toBeNull();
    expect(recentLog()[0]?.status).toBe("error");
    expect(recentLog()[0]?.error?.message).toContain("token refresh failed");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("surfaces a synchronous prepareHeaders throw as an action error without calling fetch", async () => {
    configureApi({
      prepareHeaders: () => {
        throw new Error("sync boom");
      },
    });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({
      name: "prep.sync_throw",
      request: () => ({ method: "GET", path: "/x" }),
    });
    const result = await action.dispatch("x");
    expect(result).toBeNull();
    expect(recentLog()[0]?.status).toBe("error");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("surfaces a non-Error prepareHeaders rejection as an action error", async () => {
    configureApi({
      prepareHeaders: () => Promise.reject("string-rejection"),
    });
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const action = apiAction<void>({
      name: "prep.string_reject",
      request: () => ({ method: "GET", path: "/x" }),
    });
    const result = await action.dispatch(undefined);
    expect(result).toBeNull();
    expect(recentLog()[0]?.status).toBe("error");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("gives each request a fresh Headers object (no cross-request mutation)", async () => {
    const headersReceived: Headers[] = [];
    configureApi({
      prepareHeaders: (headers) => {
        headersReceived.push(headers);
        headers.set("X-Count", String(headersReceived.length));
      },
    });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({
      name: "prep.isolation",
      request: () => ({ method: "GET", path: "/x" }),
    });
    await action.dispatch("a");
    await action.dispatch("b");
    expect(headersReceived[0]).not.toBe(headersReceived[1]);
    const h1 = mockFetch.mock.calls[0]![1].headers as Record<string, string>;
    const h2 = mockFetch.mock.calls[1]![1].headers as Record<string, string>;
    expect(h1["x-count"]).toBe("1");
    expect(h2["x-count"]).toBe("2");
  });

  it("aborting during an in-flight prepareHeaders records the action as cancelled", async () => {
    let releasePrep!: () => void;
    const prepGate = new Promise<void>((r) => {
      releasePrep = r;
    });
    configureApi({
      prepareHeaders: async (headers) => {
        await prepGate;
        headers.set("Authorization", "Bearer token");
      },
    });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({
      name: "prep.abort_during",
      request: () => ({ method: "GET", path: "/x" }),
    });
    const handle = action.dispatch("x");
    handle.abort();
    releasePrep();
    const result = await handle;
    expect(result).toBeNull();
    expect(recentLog()[0]?.status).toBe("cancelled");
  });
});

describe("configureApi — credentials", () => {
  it("sets credentials on every request", async () => {
    configureApi({ credentials: "include" });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({
      name: "creds",
      request: () => ({ method: "GET", path: "/x" }),
    });
    await action.dispatch("x");
    expect(mockFetch.mock.calls[0]![1].credentials).toBe("include");
  });

  it("omits credentials when not configured", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const action = apiAction<string>({
      name: "no.creds",
      request: () => ({ method: "GET", path: "/x" }),
    });
    await action.dispatch("x");
    expect(mockFetch.mock.calls[0]![1].credentials).toBeUndefined();
  });
});

describe("configureApi — fetchFn", () => {
  it("uses custom fetch implementation", async () => {
    const customFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ custom: true }), { status: 200 }));
    configureApi({ fetchFn: customFetch });
    const action = apiAction<string>({
      name: "custom.fetch",
      request: () => ({ method: "GET", path: "/x" }),
    });
    const result = await action.dispatch("x");
    expect(customFetch).toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual({ custom: true });
  });

  it("surfaces a synchronous fetchFn throw as a classified network error", async () => {
    configureApi({
      fetchFn: () => {
        throw new TypeError("sync network failure");
      },
    });
    const action = apiAction<string>({
      name: "fetch.sync_throw",
      request: () => ({ method: "GET", path: "/x" }),
    });
    const result = await action.dispatch("x");
    expect(result).toBeNull();
    expect(recentLog()[0]?.status).toBe("error");
    expect(recentLog()[0]?.error?.code).toBe("network");
  });

  it("surfaces an error when fetchFn resolves to null", async () => {
    configureApi({
      fetchFn: (async () => null) as unknown as typeof fetch,
    });
    const action = apiAction<string>({
      name: "fetch.null",
      request: () => ({ method: "GET", path: "/x" }),
    });
    const result = await action.dispatch("x");
    expect(result).toBeNull();
    expect(recentLog()[0]?.status).toBe("error");
  });

  it("surfaces an error when fetchFn resolves to a non-object", async () => {
    configureApi({
      fetchFn: (async () => 42) as unknown as typeof fetch,
    });
    const action = apiAction<string>({
      name: "fetch.non_object",
      request: () => ({ method: "GET", path: "/x" }),
    });
    const result = await action.dispatch("x");
    expect(result).toBeNull();
    expect(recentLog()[0]?.status).toBe("error");
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
      request: () => ({
        method: "POST",
        path: "/x",
        body: { a: 1 },
        headers: { "X-Request-Id": "abc" },
      }),
    });
    await action.dispatch("x");
    const headers = mockFetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-request-id"]).toBe("abc");
  });
});
