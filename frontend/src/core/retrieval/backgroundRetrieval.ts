import { isAbortError } from "@/core/lib/errors";

export type RetrievalMode = "initial" | "background";

interface BackgroundRetrievalConfig<TData> {
  hasCachedData: boolean;
  onBegin: (mode: RetrievalMode) => void;
  retrieve: () => Promise<TData>;
  onSuccess: (data: TData, mode: RetrievalMode) => void;
  onError: (error: unknown, mode: RetrievalMode) => void;
  onAbort?: (mode: RetrievalMode) => void;
  /**
   * Optional stale-guard for callers with overlapping requests.
   * When true, completion callbacks are skipped to prevent stale state writes.
   */
  isStale?: () => boolean;
}

/**
 * Shared stale-while-revalidate retrieval flow:
 * - Initial mode: no cache, show loading state
 * - Background mode: keep cached state visible while refreshing
 */
export async function runBackgroundRetrieval<TData>({
  hasCachedData,
  onBegin,
  retrieve,
  onSuccess,
  onError,
  onAbort,
  isStale,
}: BackgroundRetrievalConfig<TData>): Promise<void> {
  const mode: RetrievalMode = hasCachedData ? "background" : "initial";
  onBegin(mode);

  try {
    const data = await retrieve();
    if (isStale?.()) return;
    onSuccess(data, mode);
  } catch (error) {
    if (isStale?.()) return;
    if (isAbortError(error)) {
      onAbort?.(mode);
      return;
    }
    onError(error, mode);
  }
}
