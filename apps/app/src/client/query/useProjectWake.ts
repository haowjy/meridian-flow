import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useOptionalThreadTransport } from "@/client/providers/TransportProvider";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { bumpLinkResolutionEpoch } from "./link-resolution-epoch";
import { projectQueryKeys } from "./project-query-keys";
import { invalidateAgentReads } from "./useAgentFiles";
import { invalidateMcpConnections } from "./useMcpConnections";
import { refreshDraftReads } from "./useOwnerDrafts";

export function useProjectWake(projectId: string): void {
  const queryClient = useQueryClient();
  const transport = useOptionalThreadTransport();
  const accountId = useAccountId();
  useEffect(() => {
    if (!projectId || !transport) return;
    // Another client's reply or question: the chat list's marks and the chat feed's rows follow
    // it. A read someone else started may predate this hint's commit, so the refresh cancels and
    // restarts it; a hint that lands during our own refresh queues exactly one more after it.
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
        queryClient.invalidateQueries({
          queryKey: projectQueryKeys.threads(projectId),
          exact: true,
        }),
        queryClient.invalidateQueries({ queryKey: projectQueryKeys.chatFeed(projectId) }),
      ]).finally(() => {
        refreshing = false;
        if (active && trailing) {
          trailing = false;
          refreshChats();
        }
      });
    };
    // Drafts' lists are stale, every draft's when the set holds `undefined`. An Apply of many
    // documents sends a hint per document: as with chats, one read runs and one more follows it.
    let draftsRefreshing = false;
    let draftsTrailing: Set<string | undefined> | null = null;
    const readDrafts = (drafts: ReadonlySet<string | undefined>) => {
      draftsRefreshing = true;
      void refreshDraftReads(queryClient, projectId, drafts).finally(() => {
        draftsRefreshing = false;
        const next = draftsTrailing;
        draftsTrailing = null;
        if (active && next) readDrafts(next);
      });
    };
    const refreshDrafts = (draft?: string) => {
      if (!draftsRefreshing) {
        readDrafts(new Set([draft]));
        return;
      }
      draftsTrailing ??= new Set();
      draftsTrailing.add(draft);
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
        if (hint.recheckTabs) {
          refreshDrafts();
          refreshSources();
          void invalidateAgentReads(queryClient, projectId, accountId);
          void invalidateMcpConnections(queryClient, accountId);
        }
      } else if (hint.type === "draft-hint") {
        refreshDrafts(hint.draft);
      } else if (hint.type === "context-sources-hint") {
        refreshSources();
      } else if (hint.type === "agent-files-hint") {
        void invalidateAgentReads(queryClient, projectId, accountId);
      } else if (hint.type === "mcp-connections-hint") {
        void invalidateMcpConnections(queryClient, accountId);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [projectId, queryClient, transport, accountId]);
}
