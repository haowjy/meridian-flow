/**
 * Pure thread-switcher decisions: title filtering and search visibility.
 */
type SwitcherThread = {
  title: string | null;
};

export const THREAD_SWITCHER_SEARCH_THRESHOLD = 8;

export function filterThreadsByTitle<T extends Pick<SwitcherThread, "title">>(
  threads: readonly T[],
  query: string,
): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...threads];

  return threads.filter((thread) =>
    thread.title?.trim().toLocaleLowerCase().includes(normalizedQuery),
  );
}

export function shouldShowThreadSearch(threadCount: number): boolean {
  return threadCount >= THREAD_SWITCHER_SEARCH_THRESHOLD;
}
