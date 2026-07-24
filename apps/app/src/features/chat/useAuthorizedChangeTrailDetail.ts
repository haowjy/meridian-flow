/** Authorization-sensitive change-view data lifecycle. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { type ChangeTrailShell, readChangeTrail } from "@/client/change-trails";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";

export const changeTrailDetailKey = (threadId: string, trailId: string) =>
  ["change-trail-detail", threadId, trailId] as const;

export function useAuthorizedChangeTrailDetail(
  threadId: string,
  shell: ChangeTrailShell,
  enabled: boolean,
) {
  const queryClient = useQueryClient();
  const settled = shell.state === "settled";
  const evict = useCallback(() => {
    void queryClient.removeQueries({ queryKey: changeTrailDetailKey(threadId, shell.trailId) });
  }, [queryClient, shell.trailId, threadId]);
  const detail = useQuery({
    queryKey: [...changeTrailDetailKey(threadId, shell.trailId), shell.version],
    queryFn: () => readChangeTrail(threadId, shell.trailId),
    enabled: enabled && settled,
    staleTime: 0,
    gcTime: 0,
    retry: 2,
  });

  useEffect(() => {
    if (!enabled) {
      void queryClient.removeQueries({
        queryKey: changeTrailDetailKey(threadId, shell.trailId),
      });
      return;
    }
    const registry = getDocumentSessionRegistry();
    const unsubscribers = (detail.data ?? []).map((document) =>
      registry.observe(document.documentId, (snapshot) => {
        if (snapshot.status === "access-lost") evict();
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [detail.data, enabled, evict, queryClient, shell.trailId, threadId]);
  useEffect(() => evict, [evict]);

  return {
    detail,
    evict,
  };
}
