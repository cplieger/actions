export { configure } from "./notifier.js";
export type { Notifier, NotifierRetry } from "./notifier.js";

export { configureTransport, transportAction, IDEMPOTENCY_COMMAND_FIELD } from "./transport.js";
export type { TransportSendResult, TransportCommand, TransportSendFn } from "./transport.js";

export { defineAction, IDEMPOTENCY_HEADER } from "./define.js";
export { apiAction, configureApi } from "./api.js";
export type {
  ApiConfig,
  ApiActionDefinition,
  ApiDecodeContext,
  ApiErrorInfo,
  ApiErrorDecision,
} from "./api.js";

export { ActionError, hasErrorString, classifyFetchError, retryNetwork } from "./error.js";

export {
  subscribe as subscribeToActions,
  subscribeByName,
  getActionLog,
  pendingCount,
  isPending,
} from "./registry.js";

export { bindLoadingState } from "./loading.js";

export { withAsyncFeedback } from "./async-feedback.js";
export type { AsyncFeedbackOptions } from "./async-feedback.js";

export { registerCleanup } from "./cleanup.js";

export { debouncedDispatch } from "./debounce.js";
export type { DebouncedDispatch } from "./debounce.js";

export { pollAction } from "./poll.js";
export type { PollOptions } from "./poll.js";

export { pollUntil } from "./poll-until.js";
export type { PollUntilOptions, PollUntilOutcome } from "./poll-until.js";

export type {
  Action,
  ActionContext,
  ActionDefinition,
  ActionErrorLike,
  ActionInstance,
  ActionLifecycleStatus,
  ActionOutcome,
  DispatchHandle,
  DispatchOptions,
  NotificationSpec,
  RegistryListener,
  RequestSpec,
  RetryConfig,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- backward-compat alias
  ToastSpec,
} from "./types.js";
export { RETRY_STANDARD } from "./types.js";
