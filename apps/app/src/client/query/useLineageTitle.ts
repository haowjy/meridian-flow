/**
 * The writer's name for a chat's Scratch: its first chat's title.
 *
 * A lineage is never named by its handle (`c12`) or its id. Null while the
 * project's chats have not loaded, or when the first chat is not among them
 * (removed), so a caller words the owner generically instead of guessing.
 */
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { displayThreadTitle } from "@/lib/thread-title";

export type LineageKey = { rootThreadId: string } | { rootThreadRef: string };

export function useLineageTitle(projectId: string | null, key: LineageKey | null): string | null {
  const { threads } = useProjectThreads(projectId ?? "", { enabled: Boolean(projectId && key) });
  if (!key) return null;
  const first = threads?.find((thread) =>
    "rootThreadId" in key
      ? thread.id === key.rootThreadId
      : thread.ref === key.rootThreadRef && thread.rootThreadId === thread.id,
  );
  return first ? displayThreadTitle(first.title) : null;
}
