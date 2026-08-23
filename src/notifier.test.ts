// Notifier unwired-slot policy: unconfigured drops warn once (the
// silent-by-default footgun); an explicit configure() — even an empty or
// partial one — is the documented headless opt-in and stays silent.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { configure, notifyError, notifySuccess, _resetNotifierForTest } from "./notifier.js";

beforeEach(() => {
  _resetNotifierForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("notifier unconfigured-drop warning", () => {
  it("warns exactly once when notifications drop before configure()", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    notifySuccess("first");
    notifyError("second");
    notifySuccess("third");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("configure() was never called");
  });

  it("stays silent when configure({}) opted into headless mode", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    configure({});
    notifySuccess("dropped deliberately");
    notifyError("dropped deliberately");
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent for a partially-configured notifier's missing method", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.fn();
    configure({ error });
    notifySuccess("no success handler — deliberate");
    notifyError("delivered");
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("delivered", undefined);
  });

  it("delivers to configured methods with the retry descriptor", () => {
    const success = vi.fn();
    const error = vi.fn();
    configure({ success, error });
    notifySuccess("ok");
    const retry = { onClick: (): void => undefined };
    notifyError("bad", retry);
    expect(success).toHaveBeenCalledWith("ok");
    expect(error).toHaveBeenCalledWith("bad", retry);
  });

  it("re-arms the warning after a test reset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    notifySuccess("drop 1");
    _resetNotifierForTest();
    notifySuccess("drop 2");
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
