/**
 * The project's one live subscription to the server's wake hints. A hint carries no state: it says
 * a read is stale, and the read comes again. The tree itself is not read this way (the project's
 * list arrives as Yjs updates), so the hints left are the chat list, a draft owner's list and the
 * project's sources.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useOptionalThreadTransport } from "@/client/providers/TransportProvider";
import { bumpLinkResolutionEpoch } from "./link-resolution-epoch";
import { projectQueryKeys } from "./project-query-keys";
import { refreshWorksSnapshot } from "./works-projection-acquisition";

export function useProjectWake(projectId: string): void {
  const queryClient = useQueryClient();
  const transport = useOptionalThreadTransport();
  useEffect(() => {
    if (!projectId || !transport) return;
    // Another client's reply or question: the chat list's marks and the chat feed's rows follow
    // it. A read already under way may have started before this hint's commit, so a hint that
    // lands during a refresh queues exactly one more after it.
    let refreshing = false;
    let trailing = false;
    let active = true;
    const refreshChats = () => {
      if (refreshing) {
        trailing = true;
        return;
      }
      refreshing = true;
      void Promise.all([
        queryClient.invalidateQueries(
          { queryKey: projectQueryKeys.threads(projectId), exact: true },
          { cancelRefetch: false },
        ),
        queryClient.invalidateQueries(
          { queryKey: projectQueryKeys.chatFeed(projectId) },
          { cancelRefetch: false },
        ),
      ]).finally(() => {
        refreshing = false;
        if (active && trailing) {
          trailing = false;
          refreshChats();
        }
      });
    };
    const unsubscribe = transport.subscribeCatalog(projectId, (hint) => {
      if (hint.type === "project-chats-hint") {
        refreshChats();
      } else if (hint.type === "draft-owner-hint") {
        void queryClient.invalidateQueries({
          queryKey: projectQueryKeys.ownerDrafts(projectId, hint.owner),
        });
        void queryClient.invalidateQueries({
          queryKey: projectQueryKeys.documentDraftHintsOf(projectId),
        });
        bumpLinkResolutionEpoch(projectId);
      } else if ((hint.type as string) === "context-sources-hint") {
        // A Work or a chat gained or lost a source (Scratch, uploads): which trees exist changed,
        // and a Work that ended or came back is a change to the Works list.
        void queryClient.invalidateQueries({
          queryKey: projectQueryKeys.contextSources(projectId),
        });
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.accountContextSources() });
        void refreshWorksSnapshot(queryClient, projectId).catch(() =>
          queryClient.invalidateQueries({
            queryKey: projectQueryKeys.works(projectId),
            exact: true,
            refetchType: "none",
          }),
        );
        bumpLinkResolutionEpoch(projectId);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [projectId, queryClient, transport]);
}
