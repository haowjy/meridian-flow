/** Authorization-sensitive detail lifecycle for one change-trail disclosure. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { type ChangeTrailShell, readChangeTrail } from "@/client/change-trails";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";

const detailKey = (threadId: string, trailId: string) => ["change-trail-detail", threadId, trailId];

export function useAuthorizedChangeTrailDetail(threadId: string, shell: ChangeTrailShell) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const settled = shell.state === "settled";
  const evict = useCallback(() => {
    setOpen(false);
    void queryClient.removeQueries({ queryKey: detailKey(threadId, shell.trailId) });
  }, [queryClient, shell.trailId, threadId]);
  const detail = useQuery({
    queryKey: [...detailKey(threadId, shell.trailId), shell.version],
    queryFn: () => readChangeTrail(threadId, shell.trailId),
    enabled: open && settled,
    staleTime: 0,
    gcTime: 0,
    retry: 2,
  });

  useEffect(() => {
    if (!open) {
      void queryClient.removeQueries({ queryKey: detailKey(threadId, shell.trailId) });
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
  }, [detail.data, evict, open, queryClient, shell.trailId, threadId]);
  useEffect(() => evict, [evict]);

  return {
    detail,
    open,
    toggle: () => {
      if (settled) setOpen((current) => !current);
    },
    evict,
  };
}
