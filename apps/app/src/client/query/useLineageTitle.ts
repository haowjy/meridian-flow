/**
 * The writer's name for a chat's Scratch: its first chat's title.
 *
 * A lineage is never named by its handle (`c12`) or its id. The live chat list
 * answers first and stays current through renames. A lineage outlives its
 * first chat's trash while a fork lives, and the live list has no trashed
 * chats, so then the lineage route answers. Null until either does.
 */
import { useQuery } from "@tanstack/react-query";
import { getContextLineage } from "@/client/api/projects-api";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { displayThreadTitle } from "@/lib/thread-title";

export type LineageKey = { rootThreadId: string } | { rootThreadRef: string };

export function useLineage(
  projectId: string | null,
  key: LineageKey | null,
): { title: string | null; rootThreadRef: string | null } | null {
  const { threads } = useProjectThreads(projectId ?? "", { enabled: Boolean(projectId && key) });
  const live = key
    ? threads?.find((thread) =>
        "rootThreadId" in key
          ? thread.id === key.rootThreadId
          : thread.ref === key.rootThreadRef && thread.rootThreadId === thread.id,
      )
    : undefined;
  // Only an id can ask the route; a handle names a chat the live list must hold.
  const rootThreadId = key && "rootThreadId" in key ? key.rootThreadId : null;
  const stored = useQuery({
    queryKey: ["projects", projectId, "lineage", rootThreadId],
    queryFn: ({ signal }) => getContextLineage(projectId as string, rootThreadId as string, signal),
    enabled: Boolean(projectId && rootThreadId && threads && !live),
    staleTime: 60_000,
    retry: false,
  });
  if (live) return { title: displayThreadTitle(live.title), rootThreadRef: live.ref };
  if (stored.data)
    return {
      title: stored.data.title ? displayThreadTitle(stored.data.title) : null,
      rootThreadRef: stored.data.rootThreadRef,
    };
  return null;
}

export function useLineageTitle(projectId: string | null, key: LineageKey | null): string | null {
  return useLineage(projectId, key)?.title ?? null;
}
