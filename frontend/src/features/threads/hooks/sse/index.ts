/**
 * SSE Module Index
 *
 * Re-exports the main useThreadSSE hook and related utilities.
 * This module is the public API for SSE functionality.
 */

export { useThreadSSE } from "./useSSEConnection";
export { dispatchSSEEvent } from "./SSEEventDispatcher";
export type { SSEDispatchContext, SSEStoreActions } from "./types";
