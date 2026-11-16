/**
 * The project's one live subscription to the server's wake hints. A hint carries no state: it says
 * a read is stale, and the read comes again. The tree itself is not read this way (the project's
 * list arrives as Yjs updates), so the hints left are the chat list, a draft owner's list (and,
 * for a Work, its row in the Works list: its count and its lifecycle), the project's sources, and
 * what Mars reads of the Agent files, and the writer's connections.
 * Hints sent while the socket was down are lost, so a reconnect makes every one of those stale.
 */
import { workIdOfDraftOwnerKey } from "@meridian/contracts/branches";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useOptionalThreadTransport } from "@/client/providers/TransportProvider";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { bumpLinkResolutionEpoch } from "./link-resolution-epoch";
import { projectQueryKeys } from "./project-query-keys";
import { invalidateAgentReads } from "./useAgentFiles";
import { invalidateMcpConnections } from "./useMcpConnections";
import { repairWorksSnapshot } from "./works-projection-acquisition";

export function useProjectWake(projectId: string): void {
  const queryClient = useQueryClient();
  const transport = useOptionalThreadTransport();
  const accountId = useAccountId();
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
    // A draft owner's list is stale, or every owner's when `owner` is not named.
    const refreshDrafts = (owner?: string) => {
      void queryClient.invalidateQueries({
        queryKey:
          owner === undefined
            ? projectQueryKeys.ownerDraftsOf(projectId)
            : projectQueryKeys.ownerDrafts(projectId, owner),
      });
      // Which drafts are open is each draft's metadata too: a restore elsewhere reopens one
      // this tab holds as ended, and its rows and rooms follow the fresh answer.
      void queryClient.invalidateQueries({
        queryKey:
          owner === undefined
            ? projectQueryKeys.draftMetadataOf(projectId)
            : projectQueryKeys.ownerDraftMetadataOfOwner(projectId, owner),
      });
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.trashDiscards(projectId) });
      // A Work's count and lifecycle are the Works list's: the picker and Changes read them there.
      if (owner === undefined || workIdOfDraftOwnerKey(owner))
        void repairWorksSnapshot(queryClient, projectId);
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.documentDraftHintsOf(projectId),
      });
      bumpLinkResolutionEpoch(projectId);
    };
    const refreshSources = () => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.contextSources(projectId),
      });
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.accountContextSources() });
      bumpLinkResolutionEpoch(projectId);
    };
    const unsubscribe = transport.subscribeCatalog(projectId, (hint) => {
      if (hint.type === "project-chats-hint") {
        refreshChats();
        // Hints were lost (a reconnect) or a Work went: every read a hint covers is stale.
        if (hint.recheckTabs) {
          refreshDrafts();
          refreshSources();
          void invalidateAgentReads(queryClient, projectId, accountId);
          void invalidateMcpConnections(queryClient, accountId);
        }
      } else if (hint.type === "draft-owner-hint") {
        refreshDrafts(hint.owner);
      } else if (hint.type === "context-sources-hint") {
        // A chat or a lineage gained or lost a source (Scratch, uploads): which trees exist changed.
        refreshSources();
      } else if (hint.type === "agent-files-hint") {
        // An Agent file's text changed elsewhere (another tab, the AI): its verdict is read again.
        void invalidateAgentReads(queryClient, projectId, accountId);
      } else if (hint.type === "mcp-connections-hint") {
        // A connection was checked, edited or removed: its status and tools are read again.
        void invalidateMcpConnections(queryClient, accountId);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [projectId, queryClient, transport, accountId]);
}
