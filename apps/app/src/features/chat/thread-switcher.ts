/**
 * Pure thread-switcher decisions: title filtering and attention/search visibility.
 */
import type { ThreadAttention } from "@meridian/contracts/protocol";

type SwitcherThread = {
  id: string;
  title: string | null;
  attention: ThreadAttention;
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

export function hasOtherThreadAttention(
  threads: readonly Pick<SwitcherThread, "id" | "attention">[],
  activeThreadId: string,
): boolean {
  return threads.some((thread) => thread.id !== activeThreadId && thread.attention !== "none");
}
