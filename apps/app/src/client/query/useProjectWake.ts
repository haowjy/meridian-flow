import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useAccountId } from "@/client/account/account-context";
import { useOptionalThreadTransport } from "@/client/providers/TransportProvider";
import { singleFlight } from "@/lib/single-flight";
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
    // A read someone else started may predate the hint's commit, so each refresh cancels and
    // restarts it.
    let active = true;
    const refreshChats = singleFlight(async () => {
      if (!active) return;
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: projectQueryKeys.threads(projectId),
          exact: true,
        }),
        queryClient.invalidateQueries({ queryKey: projectQueryKeys.chatFeed(projectId) }),
      ]);
    });
    const refreshDrafts = singleFlight<string | undefined>(async (drafts) => {
      if (active) await refreshDraftReads(queryClient, projectId, new Set(drafts));
    });
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
          refreshDrafts(undefined);
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
