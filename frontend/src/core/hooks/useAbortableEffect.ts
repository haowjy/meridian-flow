import { useEffect, useRef, type DependencyList } from "react";

/**
 * A hook for managing async effects with automatic AbortController lifecycle.
 *
 * Automatically handles:
 * - Canceling in-flight requests when dependencies change
 * - Cleanup on component unmount
 * - Providing an AbortSignal to the effect callback
 *
 * @param effect - Async effect function that receives an AbortSignal
 * @param deps - Dependency array (like useEffect)
 *
 * @example
 * // Basic usage - load data when id changes
 * useAbortableEffect(
 *   (signal) => {
 *     void loadData(id, signal)
 *   },
 *   [id]
 * )
 *
 * @example
 * // With early return guard
 * useAbortableEffect(
 *   (signal) => {
 *     if (!projectId) return
 *     void loadThreads(projectId, signal)
 *   },
 *   [projectId]
 * )
 */
export function useAbortableEffect(
  effect: (signal: AbortSignal) => void,
  deps: DependencyList,
): void {
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Cancel any in-flight request before starting a new one to prevent race conditions:
    // If deps change rapidly, previous request should not overwrite newer data
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const abortController = new AbortController();
    abortRef.current = abortController;

    effect(abortController.signal);

    return () => {
      abortController.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
