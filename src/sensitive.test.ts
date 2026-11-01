import { describe, it, expect, vi, beforeEach } from "vitest";
import { defineAction } from "./define.js";
import { ActionError } from "./error.js";
import { configure } from "./notifier.js";
import { getActionLog, subscribe, subscribeByName } from "./registry.js";
import { resetActionFramework } from "./test-helpers/action-test-setup.js";
import type { ActionInstance } from "./types.js";

beforeEach(() => {
  resetActionFramework();
  configure({});
});

/** True when `target` is reachable from `root` through own properties,
 *  array elements, or Map and Set entries, compared with `===`. */
function holds(root: unknown, target: object, seen = new Set<unknown>()): boolean {
  if (root === target) {
    return true;
  }
  if (root === null || typeof root !== "object" || seen.has(root)) {
    return false;
  }
  seen.add(root);
  if (root instanceof Map) {
    return [...root.entries()].some((pair) => holds(pair, target, seen));
  }
  if (root instanceof Set) {
    return [...root].some((v) => holds(v, target, seen));
  }
  return Reflect.ownKeys(root).some((k) =>
    holds((root as Record<PropertyKey, unknown>)[k], target, seen),
  );
}

interface Captured {
  readonly records: ActionInstance[];
  readonly logs: (readonly ActionInstance[])[];
}

function capture(name: string): Captured {
  const records: ActionInstance[] = [];
  const logs: (readonly ActionInstance[])[] = [];
  subscribe((inst) => {
    records.push(inst);
    logs.push(getActionLog());
  });
  subscribeByName(name, (inst) => {
    records.push(inst);
  });
  return { records, logs };
}

function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
}

describe("a sensitive definition", () => {
  it("keeps args and result out of every record and log snapshot, in flight and settled", async () => {
    const secretArgs = { password: "hunter2" };
    const secretResult = { token: "minted" };
    const work = gate();
    const seen = capture("auth.set_password");
    const defSuccess = vi.fn();
    const callSuccess = vi.fn();
    const action = defineAction<typeof secretArgs, typeof secretResult>({
      name: "auth.set_password",
      sensitive: true,
      onSuccess: defSuccess,
      run: async () => {
        await work.wait;
        return secretResult;
      },
    });

    const h = action.dispatch(secretArgs, { onSuccess: callSuccess });
    const inFlight = getActionLog();
    work.open();
    const value = await h;
    const settledLog = getActionLog();

    expect(seen.records.map((r) => r.status)).toEqual(["pending", "pending", "success", "success"]);
    for (const r of seen.records) {
      expect(r.sensitive).toBe(true);
      expect("args" in r).toBe(false);
      expect("result" in r).toBe(false);
    }
    const settled = seen.records.filter((r) => r.status === "success");
    for (const r of settled) {
      expect(r).toMatchObject({ name: "auth.set_password", attempts: 1 });
      expect(r.completedAt).toBeGreaterThanOrEqual(r.startedAt);
    }
    expect(seen.records.filter((r) => r.status === "pending").some((r) => "completedAt" in r)).toBe(
      false,
    );
    const everything = [seen.records, seen.logs, inFlight, settledLog];
    expect(holds(everything, secretArgs)).toBe(false);
    expect(holds(everything, secretResult)).toBe(false);

    expect(value).toBe(secretResult);
    expect(await h.outcome).toMatchObject({ status: "success", value: secretResult });
    expect(defSuccess).toHaveBeenCalledWith(secretResult, secretArgs);
    expect(callSuccess).toHaveBeenCalledWith(secretResult, secretArgs);
  });

  it("keeps args out of the error and cancelled records", async () => {
    const secretArgs = { password: "hunter2" };
    const lane = gate();
    const seen = capture("auth.sign_in");
    const occupant = defineAction<void, void>({
      name: "occupant",
      scope: "auth",
      run: () => lane.wait,
    });
    const action = defineAction<typeof secretArgs, void>({
      name: "auth.sign_in",
      sensitive: true,
      scope: "auth",
      error: false,
      run: () => Promise.reject(new ActionError("refused", { status: 401 })),
    });

    const pOccupant = occupant.dispatch();
    const queued = action.dispatch(secretArgs);
    queued.abort();
    lane.open();
    await pOccupant;
    const failed = action.dispatch(secretArgs);
    await failed;

    expect(seen.records.map((r) => r.status)).toEqual(
      expect.arrayContaining(["cancelled", "error"]),
    );
    expect(holds([seen.records, seen.logs, getActionLog()], secretArgs)).toBe(false);
  });

  it("keeps an error quoting the args out of every record, while the caller still gets it", async () => {
    const secretArgs = { password: "hunter2-marker" };
    const seen = capture("auth.set_password");
    const defError = vi.fn();
    const callError = vi.fn();
    const action = defineAction<typeof secretArgs, void>({
      name: "auth.set_password",
      sensitive: true,
      error: false,
      onError: defError,
      run: (args) =>
        Promise.reject(new ActionError(`refused ${args.password}`, { cause: args, status: 400 })),
    });

    const h = action.dispatch(secretArgs, { onError: callError });
    await h;
    const outcome = await h.outcome;

    expect(seen.records.map((r) => r.status)).toEqual(["pending", "pending", "error", "error"]);
    for (const r of seen.records) {
      expect("error" in r).toBe(false);
    }
    const everything = [seen.records, seen.logs, getActionLog()];
    expect(holds(everything, secretArgs)).toBe(false);
    expect(JSON.stringify(everything)).not.toContain("hunter2-marker");

    expect(outcome.status).toBe("error");
    const err = outcome.status === "error" ? outcome.error : undefined;
    expect(err?.cause).toBe(secretArgs);
    expect(defError).toHaveBeenCalledWith(err, secretArgs);
    expect(callError).toHaveBeenCalledWith(err, secretArgs);
  });

  it("is what keeps them out: the same dispatch without it records both", async () => {
    const plainArgs = { note: "hello" };
    const plainResult = { id: 1 };
    const seen = capture("notes.add");
    const action = defineAction<typeof plainArgs, typeof plainResult>({
      name: "notes.add",
      run: async () => plainResult,
    });

    await action.dispatch(plainArgs);

    expect(holds(seen.records, plainArgs)).toBe(true);
    expect(holds(seen.records, plainResult)).toBe(true);
    expect(seen.records.some((r) => "sensitive" in r)).toBe(false);
  });

  it("is what keeps the error out: the same failure without it records the error", async () => {
    const plainArgs = { note: "hello" };
    const seen = capture("notes.add");
    const action = defineAction<typeof plainArgs, void>({
      name: "notes.add",
      error: false,
      run: (args) => Promise.reject(new ActionError("refused", { cause: args })),
    });

    await action.dispatch(plainArgs);

    const failed = seen.records.filter((r) => r.status === "error");
    expect(failed).toHaveLength(2);
    expect(failed.every((r) => r.error?.cause === plainArgs)).toBe(true);
  });

  it("refuses retry at definition", () => {
    expect(() =>
      defineAction<void, void>({
        name: "auth.retrying",
        sensitive: true,
        retry: { count: 1, delay: 10 },
        run: async () => undefined,
      }),
    ).toThrow(TypeError);
  });

  it("refuses retryable at definition, since its retry button would hold the args", () => {
    expect(() =>
      defineAction<void, void>({
        name: "auth.retry_button",
        sensitive: true,
        retryable: () => true,
        run: async () => undefined,
      }),
    ).toThrow(/retryable/);
  });

  it("registers nothing when refused", async () => {
    expect(() =>
      defineAction<void, void>({
        name: "auth.refused",
        sensitive: true,
        retryable: () => true,
        run: async () => undefined,
      }),
    ).toThrow(TypeError);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const action = defineAction<void, string>({
      name: "auth.refused",
      sensitive: true,
      run: async () => "ok",
    });

    expect(await action.dispatch()).toBe("ok");
    expect(warn).not.toHaveBeenCalled();
  });
});
