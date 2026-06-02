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
import { ActionError, retryNetwork } from "./error.js";

beforeEach(() => {
  resetDefine();
  resetRegistry();
  resetCleanup();
  vi.clearAllMocks();
});
afterEach(() => {
  if ("onLine" in navigator) {
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  }
});

describe("networkMode: 'online' (default)", () => {
  it("waits for online event before retrying when navigator.onLine is false", async () => {
    let attempts = 0;
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const action = defineAction<void, string>({
      name: "test.online.pause",
      retryable: retryNetwork,
      retry: { count: 1, delay: 5 },
      error: false,
      run: () => {
        attempts++;
        throw new ActionError("offline", { code: "network" });
      },
    });
    const p = action.dispatch();
    await new Promise((r) => setTimeout(r, 20));
    expect(attempts).toBe(1);
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    window.dispatchEvent(new Event("online"));
    await p;
    expect(attempts).toBe(2);
  });

  it("doesn't pause when online to begin with", async () => {
    let attempts = 0;
    const action = defineAction<void, string>({
      name: "test.online.normal",
      retryable: retryNetwork,
      retry: { count: 2, delay: 1 },
      error: false,
      run: () => {
        attempts++;
        throw new ActionError("blip", { code: "network" });
      },
    });
    await action.dispatch();
    expect(attempts).toBe(3);
  });

  it("cancel during offline pause unwinds cleanly without retry", async () => {
    let attempts = 0;
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const action = defineAction<void, string>({
      name: "test.online.cancel",
      retryable: retryNetwork,
      retry: { count: 5, delay: 1 },
      error: false,
      run: () => {
        attempts++;
        throw new ActionError("offline", { code: "network" });
      },
    });
    const p = action.dispatch();
    await new Promise((r) => setTimeout(r, 20));
    expect(attempts).toBe(1);
    action.cancel();
    await p;
    expect(attempts).toBe(1);
  });
});

describe("networkMode: 'always'", () => {
  it("retries even when navigator.onLine is false", async () => {
    let attempts = 0;
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const action = defineAction<void, string>({
      name: "test.always.retry",
      retryable: retryNetwork,
      retry: { count: 2, delay: 1 },
      networkMode: "always",
      error: false,
      run: () => {
        attempts++;
        throw new ActionError("ignored", { code: "network" });
      },
    });
    await action.dispatch();
    expect(attempts).toBe(3);
  });
});

describe("retry.delay as a function", () => {
  it("invokes delay function with attempt number and error", async () => {
    const seen: { attempt: number; code: string | undefined }[] = [];
    let runs = 0;
    const action = defineAction<void, string>({
      name: "test.delay.fn",
      retryable: retryNetwork,
      retry: {
        count: 2,
        delay: (attempt, err) => {
          seen.push({ attempt, code: err.code });
          return 0;
        },
      },
      error: false,
      run: () => {
        runs++;
        throw new ActionError("blip", { code: "network" });
      },
    });
    await action.dispatch();
    expect(runs).toBe(3);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.attempt).toBe(1);
    expect(seen[1]?.attempt).toBe(2);
    expect(seen[0]?.code).toBe("network");
  });

  it("falls back to 0ms if delay function throws", async () => {
    let attempts = 0;
    const action = defineAction<void, string>({
      name: "test.delay.fn_throws",
      retryable: retryNetwork,
      retry: {
        count: 1,
        delay: () => {
          throw new Error("bad delay fn");
        },
      },
      error: false,
      run: () => {
        attempts++;
        throw new ActionError("blip", { code: "network" });
      },
    });
    await action.dispatch();
    expect(attempts).toBe(2);
  });
});
