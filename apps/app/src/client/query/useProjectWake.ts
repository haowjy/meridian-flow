/**
 * The project's one live subscription to the server's wake hints. A hint carries no state: it says
 * a read is stale, and the read comes again. The tree itself is not read this way (the project's
 * list arrives as Yjs updates), so the hints left are the chat list, a draft owner's list (and,
 * for a Work, its row in the Works list: its count and its lifecycle), the project's sources, and
 * what Mars reads of the Agent files.
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
    // Draft owners' lists are stale, every owner's when the set holds `undefined`. An Apply of many
    // documents sends a hint per document: as with chats, one read runs and one more follows it.
    let draftsRefreshing = false;
    let draftsTrailing: Set<string | undefined> | null = null;
    const readDrafts = (owners: ReadonlySet<string | undefined>) => {
      draftsRefreshing = true;
      const all = owners.has(undefined);
      const named = [...owners].filter((owner): owner is string => owner !== undefined);
      const reads = (all ? [undefined] : named).flatMap((owner) => [
        queryClient.invalidateQueries(
          {
            queryKey:
              owner === undefined
                ? projectQueryKeys.ownerDraftsOf(projectId)
                : projectQueryKeys.ownerDrafts(projectId, owner),
          },
          { cancelRefetch: false },
        ),
        // Which drafts are open is each draft's metadata too: a restore elsewhere reopens one
        // this tab holds as ended, and its rows and rooms follow the fresh answer.
        queryClient.invalidateQueries(
          {
            queryKey:
              owner === undefined
                ? projectQueryKeys.draftMetadataOf(projectId)
                : projectQueryKeys.ownerDraftMetadataOfOwner(projectId, owner),
          },
          { cancelRefetch: false },
        ),
      ]);
      // A Work's count and lifecycle are the Works list's: the picker and Changes read them there.
      if (all || named.some((owner) => workIdOfDraftOwnerKey(owner)))
        reads.push(repairWorksSnapshot(queryClient, projectId));
      reads.push(
        queryClient.invalidateQueries(
          { queryKey: projectQueryKeys.trashDiscards(projectId) },
          { cancelRefetch: false },
        ),
        queryClient.invalidateQueries(
          { queryKey: projectQueryKeys.documentDraftHintsOf(projectId) },
          { cancelRefetch: false },
        ),
      );
      bumpLinkResolutionEpoch(projectId);
      void Promise.allSettled(reads).finally(() => {
        draftsRefreshing = false;
        const next = draftsTrailing;
        draftsTrailing = null;
        if (active && next) readDrafts(next);
      });
    };
    const refreshDrafts = (owner?: string) => {
      if (!draftsRefreshing) {
        readDrafts(new Set([owner]));
        return;
      }
      draftsTrailing ??= new Set();
      draftsTrailing.add(owner);
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
        }
      } else if (hint.type === "draft-owner-hint") {
        refreshDrafts(hint.owner);
      } else if (hint.type === "context-sources-hint") {
        // A chat or a lineage gained or lost a source (Scratch, uploads): which trees exist changed.
        refreshSources();
      } else if (hint.type === "agent-files-hint") {
        // An Agent file's text changed elsewhere (another tab, the AI): its verdict is read again.
        void invalidateAgentReads(queryClient, projectId, accountId);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [projectId, queryClient, transport, accountId]);
}
