// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("./notifier.js", () => ({ configure: vi.fn(), notifySuccess: vi.fn(), notifyError: vi.fn(), _resetNotifierForTest: vi.fn() }));
import { defineAction, IDEMPOTENCY_HEADER, _resetForTest as resetDefine } from "./define.js";
import { apiAction } from "./api.js";
import { _resetForTest as resetRegistry, pendingCount } from "./registry.js";
import { _resetForTest as resetCleanup } from "./cleanup.js";
import { debouncedDispatch } from "./debounce.js";
import { retryNetwork } from "./error.js";

beforeEach(() => { resetDefine(); resetRegistry(); resetCleanup(); vi.clearAllMocks(); });

describe("idempotencyKey", () => {
  it("apiAction sends Idempotency-Key header when configured: true", async () => {
    const fetchSpy = vi.fn<typeof fetch>(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchSpy);
    const action = apiAction<{ id: string }>({ name: "test.idem.true", idempotencyKey: true, request: ({ id }) => ({ method: "POST", path: `/api/x/${id}`, body: {} }) });
    await action.dispatch({ id: "abc" });
    const init = fetchSpy.mock.calls[0]?.[1]!;
    const headers = init.headers as Record<string, string>;
    const hk = IDEMPOTENCY_HEADER.toLowerCase();
    expect(headers[hk]).toBeDefined();
    expect(headers[hk]!.length).toBeGreaterThan(5);
    vi.unstubAllGlobals();
  });

  it("no Idempotency-Key when idempotencyKey is undefined", async () => {
    const fetchSpy = vi.fn<typeof fetch>(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchSpy);
    const action = apiAction<void>({ name: "test.idem.none", request: () => ({ method: "POST", path: "/api/x", body: {} }) });
    await action.dispatch();
    const init = fetchSpy.mock.calls[0]?.[1]!;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers[IDEMPOTENCY_HEADER.toLowerCase()]).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("custom defineAction can read idempotencyKey from ctx", async () => {
    const seen: string[] = [];
    const action = defineAction<void, void>({ name: "test.idem.ctx", idempotencyKey: true, run: (_args, _signal, ctx) => { if (ctx?.idempotencyKey !== undefined) { seen.push(ctx.idempotencyKey); } return Promise.resolve(); } });
    await action.dispatch();
    await action.dispatch();
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("retries reuse the same idempotency key across attempts", async () => {
    let attempt = 0;
    const fetchSpy = vi.fn<typeof fetch>(() => { attempt++; if (attempt < 3) { return Promise.reject(new TypeError("Failed to fetch")); } return Promise.resolve(new Response("{}", { status: 200 })); });
    vi.stubGlobal("fetch", fetchSpy);
    vi.useFakeTimers();
    const action = apiAction<void>({ name: "test.idem.retry", idempotencyKey: true, retryable: retryNetwork, retry: { count: 2, delay: 50 }, request: () => ({ method: "POST", path: "/api/x", body: {} }) });
    const p = action.dispatch();
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const k1 = (fetchSpy.mock.calls[0]?.[1])!.headers as Record<string, string>;
    const k2 = (fetchSpy.mock.calls[1]?.[1])!.headers as Record<string, string>;
    const k3 = (fetchSpy.mock.calls[2]?.[1])!.headers as Record<string, string>;
    const hk = IDEMPOTENCY_HEADER.toLowerCase();
    expect(k1[hk]).toBe(k2[hk]);
    expect(k2[hk]).toBe(k3[hk]);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});

describe("dedupe", () => {
  it("two concurrent dispatches with matching args share one in-flight promise", async () => {
    let resolveRun: ((v: string) => void) | undefined;
    let runCalls = 0;
    const action = defineAction<{ id: string }, string>({ name: "test.dedupe", dedupe: true, run: () => { runCalls++; return new Promise<string>((r) => { resolveRun = r; }); } });
    const p1 = action.dispatch({ id: "a" });
    const p2 = action.dispatch({ id: "a" });
    expect(runCalls).toBe(1);
    resolveRun?.("ok");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("ok");
    expect(r2).toBe("ok");
  });

  it("different args do NOT collapse", async () => {
    let runCalls = 0;
    const action = defineAction<{ id: string }, string>({ name: "test.dedupe.different", dedupe: true, run: (args) => { runCalls++; return Promise.resolve(args.id); } });
    await Promise.all([action.dispatch({ id: "a" }), action.dispatch({ id: "b" })]);
    expect(runCalls).toBe(2);
  });

  it("dedupe entry clears after resolution; subsequent dispatch starts fresh", async () => {
    let runCalls = 0;
    const action = defineAction<{ id: string }, void>({ name: "test.dedupe.clear", dedupe: true, run: () => { runCalls++; return Promise.resolve(); } });
    await action.dispatch({ id: "a" });
    await action.dispatch({ id: "a" });
    expect(runCalls).toBe(2);
  });
});

describe("pendingCount", () => {
  it("sums across all action names without arguments", async () => {
    let resolveA: () => void = () => {};
    let resolveB: () => void = () => {};
    const a = defineAction<void, void>({ name: "test.pc.a", run: () => new Promise<void>((r) => { resolveA = r; }) });
    const b = defineAction<void, void>({ name: "test.pc.b", run: () => new Promise<void>((r) => { resolveB = r; }) });
    expect(pendingCount()).toBe(0);
    const pa = a.dispatch();
    const pb = b.dispatch();
    expect(pendingCount()).toBe(2);
    resolveA();
    await pa;
    expect(pendingCount()).toBe(1);
    resolveB();
    await pb;
    expect(pendingCount()).toBe(0);
  });
});

describe("debouncedDispatch", () => {
  it("coalesces rapid calls into a single dispatch with the latest args", async () => {
    vi.useFakeTimers();
    const runArgs: string[] = [];
    const action = defineAction<string, void>({ name: "test.debounce.basic", run: (args) => { runArgs.push(args); return Promise.resolve(); } });
    const dbg = debouncedDispatch(action, { wait: 100 });
    dbg("a"); dbg("b"); dbg("c");
    expect(runArgs).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(runArgs).toEqual(["c"]);
    vi.useRealTimers();
  });
});
