import { defineAction } from "./define.js";
import { ActionError } from "./error.js";
import type { Action, ActionContext, ActionDefinition } from "./types.js";

/** Result returned by the transport send function.
 *  `ok: true` means the command was accepted; `ok: false` triggers the
 *  action's error branch (rollback + notification). */
export interface TransportSendResult {
  readonly ok: boolean;
  readonly status: number;
  readonly error?: string;
  readonly code?: string;
}

/** A command object sent via the transport layer. Must include a `type`
 *  discriminator; additional fields carry the command payload. */
export interface TransportCommand {
  readonly type: string;
  [key: string]: unknown;
}

/** Signature of the consumer-provided send function.
 *  Receives the command and an options bag with an AbortSignal for cancellation. */
export type TransportSendFn = (
  cmd: TransportCommand,
  opts: { signal: AbortSignal },
) => Promise<TransportSendResult>;

/** Command field name carrying the per-dispatch idempotency key injected by
 *  {@link transportAction}. Exported so consumer-authored custom runners can
 *  share the wire convention instead of hand-copying the literal. */
export const IDEMPOTENCY_COMMAND_FIELD = "idempotency_key";

let _send: TransportSendFn | undefined;

/** Configure the global transport adapter. Call once at app boot;
 *  only needed if using `transportAction`. */
export function configureTransport(fn: TransportSendFn): void {
  _send = fn;
}

/** @internal Test-only: reset the transport to unconfigured state. */
export function _resetTransportForTest(): void {
  _send = undefined;
}

/** Caller-facing shape of a transportAction definition. `command`
 *  replaces `run`. Result is `void` because transport.send does not
 *  return a payload (the response arrives later via SSE events). */
interface TransportActionDefinition<TArgs, TOp = unknown> extends Omit<
  ActionDefinition<TArgs, void, TOp>,
  "run"
> {
  /** Build the command for this dispatch. Re-evaluated per-dispatch. */
  command: (args: TArgs) => TransportCommand;
}

/** Build an Action from a transport command descriptor. The generated
 *  `run()` calls the configured send function and throws {@link ActionError}
 *  on `!ok`, so the dispatcher's error branch fires consistently. */
export function transportAction<TArgs, TOp = unknown>(
  def: TransportActionDefinition<TArgs, TOp>,
): Action<TArgs, void> {
  const { command, ...rest } = def;
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- void used as generic type argument
  return defineAction<TArgs, void, TOp>({
    ...(rest as Omit<ActionDefinition<TArgs, void, TOp>, "run">),
    run: async (args: TArgs, signal: AbortSignal, ctx?: ActionContext) => {
      if (_send === undefined) {
        throw new ActionError("Transport not configured — call configureTransport() at boot", {
          code: "transport_not_configured",
        });
      }
      const raw = command(args);
      let cmd: TransportCommand;
      if (ctx?.idempotencyKey !== undefined) {
        cmd = { ...raw, [IDEMPOTENCY_COMMAND_FIELD]: ctx.idempotencyKey };
      } else {
        cmd = raw;
      }
      const r = await _send(cmd, { signal });
      if (!r.ok) {
        if (signal.aborted || r.code === "cancelled") {
          throw new ActionError("cancelled", { code: "cancelled" });
        }
        if (r.code === "timeout") {
          throw new ActionError(r.error ?? "Request timed out", {
            status: r.status,
            code: "timeout",
          });
        }
        if (r.code === "network") {
          throw new ActionError(r.error ?? "network error", { status: r.status, code: "network" });
        }
        const errOpts: { status: number; code?: string } = { status: r.status };
        if (r.code !== undefined) {
          errOpts.code = r.code;
        }
        throw new ActionError(r.error ?? `send failed (${String(r.status)})`, errOpts);
      }
      return undefined;
    },
  });
}
