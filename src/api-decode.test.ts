// @vitest-environment happy-dom
// apiAction decode / decodeError hooks: the response-interpretation seam for
// nonstandard HTTP envelopes (200-with-error bodies, meaningful non-2xx
// bodies) that previously forced hand-rolled defineAction runners.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetActionFramework } from "./test-helpers/action-test-setup.js";
vi.mock("./notifier.js", () => ({
  configure: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  _resetNotifierForTest: vi.fn(),
}));
import { apiAction } from "./api.js";
import { ActionError, hasErrorString } from "./error.js";
import { notifyError, notifySuccess } from "./notifier.js";
import { recentLog } from "./registry.js";

const mockFetch = vi.fn();

beforeEach(() => {
  resetActionFramework();
  vi.clearAllMocks();
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => {
  vi.restoreAllMocks();
});

interface CmdResult {
  output?: string;
}

describe("apiAction decode (2xx interpretation)", () => {
  it("routes a 200 body with an error field to the error branch (rollback + notification + registry error)", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "merge conflict" }), { status: 200 }),
    );
    const rollback = vi.fn();
    const action = apiAction<{ repo: string }, CmdResult, string>({
      name: "decode.git_envelope",
      request: ({ repo }) => ({ method: "POST", path: "/api/git/stage", body: { repo } }),
      optimistic: () => "op",
      rollback,
      decode: (data) => {
        if (hasErrorString(data) && data.error !== "") {
          throw new ActionError(data.error, { code: "git" });
        }
        return data as CmdResult;
      },
    });
    const result = await action.dispatch({ repo: "r" });
    expect(result).toBeNull();
    const log = recentLog()[0];
    expect(log?.status).toBe("error");
    expect(log?.error?.message).toBe("merge conflict");
    expect(log?.error?.code).toBe("git");
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifySuccess)).not.toHaveBeenCalled();
  });

  it("returns the decoded value on a clean 2xx", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ output: "staged", noise: 1 }), { status: 200 }),
    );
    const action = apiAction<void, CmdResult>({
      name: "decode.lift",
      request: () => ({ method: "POST", path: "/api/git/stage" }),
      decode: (data) => {
        if (hasErrorString(data) && data.error !== "") {
          throw new ActionError(data.error, { code: "git" });
        }
        const out = (data as { output?: unknown }).output;
        return typeof out === "string" ? { output: out } : {};
      },
    });
    const result = await action.dispatch();
    expect(result).toEqual({ output: "staged" });
    expect(recentLog()[0]?.status).toBe("success");
  });

  it("sees undefined for a 204 body and owns the interpretation", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const decode = vi.fn(() => ({ output: "empty" }));
    const action = apiAction<void, CmdResult>({
      name: "decode.204",
      request: () => ({ method: "POST", path: "/api/x" }),
      decode,
    });
    const result = await action.dispatch();
    expect(decode).toHaveBeenCalledWith(undefined, { status: 204, spec: expect.anything() });
    expect(result).toEqual({ output: "empty" });
  });
});

interface DeleteResult {
  code?: string;
  dependents?: string[];
}

describe("apiAction decodeError (non-2xx reinterpretation)", () => {
  it("resolves a 409 body as a success payload", async () => {
    const envelope = { code: "has_dependents", dependents: ["job-a", "job-b"] };
    mockFetch.mockResolvedValue(new Response(JSON.stringify(envelope), { status: 409 }));
    const action = apiAction<{ name: string }, DeleteResult>({
      name: "decode.delete_tool",
      request: ({ name }) => ({ method: "DELETE", path: `/api/tools/${name}` }),
      error: false,
      decodeError: (info) =>
        info.status === 409
          ? { kind: "success", value: (info.body ?? {}) as DeleteResult }
          : undefined,
    });
    const result = await action.dispatch({ name: "x" });
    expect(result).toEqual(envelope);
    expect(recentLog()[0]?.status).toBe("success");
    expect(vi.mocked(notifyError)).not.toHaveBeenCalled();
  });

  it("replaces the default error when the hook returns kind: error", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "raw upstream text" }), { status: 502 }),
    );
    const action = apiAction<void, void>({
      name: "decode.replace_error",
      request: () => ({ method: "GET", path: "/api/x" }),
      error: false,
      decodeError: (info) =>
        info.status === 502
          ? { kind: "error", error: { message: "upstream offline", status: 502, code: "upstream" } }
          : undefined,
    });
    await action.dispatch();
    const log = recentLog()[0];
    expect(log?.status).toBe("error");
    expect(log?.error?.message).toBe("upstream offline");
    expect(log?.error?.code).toBe("upstream");
  });

  it("keeps the default ActionError mapping when the hook returns undefined", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );
    const decodeError = vi.fn(() => undefined);
    const action = apiAction<void, void>({
      name: "decode.default_mapping",
      request: () => ({ method: "GET", path: "/api/x" }),
      error: false,
      decodeError,
    });
    await action.dispatch();
    expect(decodeError).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404, message: "Not found", body: { error: "Not found" } }),
      { spec: expect.anything() },
    );
    const log = recentLog()[0];
    expect(log?.error?.status).toBe(404);
    expect(log?.error?.message).toBe("Not found");
  });

  it("never runs on a transport failure (status 0), preserving retry/cancel semantics", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const decodeError = vi.fn(() => undefined);
    const action = apiAction<void, void>({
      name: "decode.transport_failure",
      request: () => ({ method: "GET", path: "/api/x" }),
      error: false,
      decodeError,
    });
    await action.dispatch();
    expect(decodeError).not.toHaveBeenCalled();
    expect(recentLog()[0]?.error?.code).toBe("network");
  });

  it("never runs on cancellation", async () => {
    mockFetch.mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));
    const decodeError = vi.fn(() => undefined);
    const action = apiAction<void, void>({
      name: "decode.cancelled",
      request: () => ({ method: "GET", path: "/api/x" }),
      error: false,
      decodeError,
    });
    const h = action.dispatch();
    h.abort();
    await h;
    expect(decodeError).not.toHaveBeenCalled();
    expect(recentLog()[0]?.status).toBe("cancelled");
  });
});
