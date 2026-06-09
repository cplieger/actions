// Public surface of the @cplieger/actions framework.
// ---------------------------------------------------------------------------

// Configuration
export { configure } from "./notifier.js";
export type { Notifier, NotifierRetry } from "./notifier.js";

// Transport injection
export { configureTransport, transportAction } from "./transport.js";
export type { TransportSendResult, TransportCommand, TransportSendFn } from "./transport.js";

// Action factories
export { defineAction } from "./define.js";
export { apiAction, configureApi, API_TIMEOUT_MS, withTimeout } from "./api.js";
export type { ApiConfig, ApiActionDefinition } from "./api.js";

// Error class + utilities
export { ActionError, hasErrorString, classifyFetchError, retryNetwork } from "./error.js";

// Registry
export {
  subscribe as subscribeToActions,
  subscribeByName,
  getActionLog,
  pendingCount,
  isPending,
} from "./registry.js";

// Loading-state helper
export { bindLoadingState } from "./loading.js";

// Async button-feedback helper
export { withAsyncFeedback } from "./async-feedback.js";
export type { AsyncFeedbackOptions } from "./async-feedback.js";

// Cleanup hooks
export { registerCleanup } from "./cleanup.js";

// Debounce helper
export { debouncedDispatch } from "./debounce.js";
export type { DebouncedDispatch } from "./debounce.js";

// Polling helper
export { pollAction } from "./poll.js";
export type { PollOptions } from "./poll.js";

// Poll-until-terminal helper
export { pollUntil } from "./poll-until.js";
export type { PollUntilOptions, PollUntilOutcome } from "./poll-until.js";

// Types
export type {
  Action,
  ActionContext,
  ActionDefinition,
  ActionErrorLike,
  ActionInstance,
  ActionLifecycleStatus,
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
