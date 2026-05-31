// Public surface of the @cplieger/actions framework.
// ---------------------------------------------------------------------------

// Configuration
export { configure } from "./notifier.js";
export type { Notifier, NotifierRetry } from "./notifier.js";

// Action factories
export { defineAction } from "./define.js";
export { apiAction, API_TIMEOUT_MS, withTimeout } from "./api.js";

// Error class + utilities
export { ActionError, hasErrorString, classifyFetchError, retryNetwork } from "./error.js";

// Registry
export { subscribe as subscribeToActions, pendingCount } from "./registry.js";

// Loading-state helper
export { bindLoadingState } from "./loading.js";

// Cleanup hooks
export { registerCleanup } from "./cleanup.js";

// Debounce helper
export { debouncedDispatch } from "./debounce.js";
export type { DebouncedDispatch } from "./debounce.js";

// Polling helper
export { pollAction } from "./poll.js";
export type { PollOptions } from "./poll.js";

// Types
export type {
  Action,
  ActionContext,
  ActionDefinition,
  ActionErrorLike,
  ActionInstance,
  ActionLifecycleStatus,
  DispatchOptions,
  RegistryListener,
  RequestSpec,
  RetryConfig,
  ToastSpec,
} from "./types.js";
export { RETRY_STANDARD } from "./types.js";
