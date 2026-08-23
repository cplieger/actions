// @vitest-environment happy-dom
// The unconfigured-drop warning fires once per process, so whichever channel
// drops FIRST is the one that has to raise it. The existing suite always drops
// a success notification first, which leaves the error channel's own call
// unasserted — an error notification silently vanishing is the worse of the two.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { notifyError, notifySuccess, _resetNotifierForTest } from "./notifier.js";

beforeEach(() => {
  _resetNotifierForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetNotifierForTest();
});

describe("notifier — the error channel raises the unconfigured-drop warning itself", () => {
  it("warns when an error notification is the first thing dropped before configure()", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    notifyError("something failed");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("error notification dropped");
    expect(warn.mock.calls[0]?.[0]).toContain("configure() was never called");
  });

  it("does not warn a second time when a success notification drops afterwards", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    notifyError("something failed");
    notifySuccess("something worked");

    expect(warn).toHaveBeenCalledTimes(1);
  });
});
