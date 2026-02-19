/**
 * Loading view state derivation hook.
 *
 * Determines which UI state to show based on loading status and data presence.
 * No timers, no delays - skeleton shows immediately and lasts as long as the
 * network request takes.
 */

export type LoadingStatus = "idle" | "loading" | "success" | "error";
export type LoadingView = "skeleton" | "content" | "empty" | "error";

interface UseLoadingViewParams {
  status: LoadingStatus;
  hasData: boolean;
}

/**
 * Derives the correct view state from loading status and data presence.
 *
 * Decision tree:
 * - Have data -> 'content' (always, even during background refresh)
 * - No data + loading/idle -> 'skeleton'
 * - No data + success -> 'empty'
 * - No data + error -> 'error'
 *
 * This is a pure derivation - no useState/useEffect needed.
 * Skeleton shows immediately on cold start (no 150ms delay that causes empty flash).
 *
 * @example
 * const view = useLoadingView({ status, hasData: items.length > 0 })
 *
 * {view === 'skeleton' && <Skeleton />}
 * {view === 'content' && <Content />}
 * {view === 'empty' && <EmptyState />}
 * {view === 'error' && <ErrorPanel />}
 */
export function useLoadingView({
  status,
  hasData,
}: UseLoadingViewParams): LoadingView {
  // Have data -> always show content (even during background refresh)
  if (hasData) return "content";

  // No data - determine what to show
  if (status === "loading" || status === "idle") return "skeleton";
  if (status === "error") return "error";

  // status === 'success' with no data
  return "empty";
}
