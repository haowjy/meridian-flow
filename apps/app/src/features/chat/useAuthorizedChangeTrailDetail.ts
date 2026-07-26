/** Authorization-sensitive change-view data lifecycle. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { type ChangeTrailShell, changeTrailDetailKey } from "@/client/change-trails";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { changeTrailDetailQuery } from "@/features/change-trail/trail-detail-query";

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
    ...changeTrailDetailQuery(threadId, shell.trailId),
    enabled: enabled && settled,
  });

  // A bumped shell version is the only way a settled trail's evidence changes
  // on its own. Refresh the shared entry rather than keying a second copy by
  // version — the peer-mark popover reads the same trail without one.
  const readVersion = useRef(shell.version);
  useEffect(() => {
    if (readVersion.current === shell.version) return;
    readVersion.current = shell.version;
    void queryClient.invalidateQueries({
      queryKey: changeTrailDetailKey(threadId, shell.trailId),
    });
  }, [queryClient, shell.trailId, shell.version, threadId]);

  useEffect(() => {
    if (!enabled) return;
    const registry = getDocumentSessionRegistry();
    const unsubscribers = (detail.data ?? []).map((document) =>
      registry.observe(document.documentId, (snapshot) => {
        if (snapshot.status === "access-lost") evict();
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [detail.data, enabled, evict]);

  return {
    detail,
    evict,
  };
}
