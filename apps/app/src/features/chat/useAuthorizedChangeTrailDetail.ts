/** Authorization-sensitive change-view data lifecycle. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { type ChangeTrailShell, changeTrailDetailKey } from "@/client/change-trails";
import { changeTrailDetailQuery } from "@/features/change-trail/trail-detail-query";
import { useProjectDocumentNavigationProjectId } from "@/features/project/context/open-project-document";
import { useAuthorizationLossEvidence } from "@/features/project/context/use-authorization-loss-evidence";

export function useAuthorizedChangeTrailDetail(
  threadId: string,
  shell: ChangeTrailShell,
  enabled: boolean,
) {
  const queryClient = useQueryClient();
  const projectId = useProjectDocumentNavigationProjectId();
  const settled = shell.state === "settled";
  const evict = useCallback(() => {
    void queryClient.removeQueries({ queryKey: changeTrailDetailKey(threadId, shell.trailId) });
  }, [queryClient, shell.trailId, threadId]);
  const authorizationLost = useAuthorizationLossEvidence({
    projectId,
    documentIds: shell.documents.map((document) => document.documentId),
    enabled: enabled && settled,
    onLoss: evict,
  });
  const detail = useQuery({
    ...changeTrailDetailQuery(threadId, shell.trailId),
    enabled: enabled && settled && !authorizationLost,
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

  return {
    detail,
    evict,
  };
}
