/**
 * useThreadSSE - SSE Connection Hook
 *
 * This file re-exports from the refactored sse/ module for backwards compatibility.
 * The actual implementation is now split into focused modules:
 * - sse/useSSEConnection.ts - Connection lifecycle
 * - sse/SSEEventDispatcher.ts - Event routing
 * - sse/eventHandlers/ - Individual event handlers
 *
 * @see sse/useSSEConnection.ts for the main implementation
 */

// Re-export the main hook
export { useThreadSSE } from "./sse";
