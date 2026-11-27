import { type AgentFiles, type AgentLevel, agentsLocationOf } from "@meridian/contracts/agents";
import { keepPreviousData, type QueryClient, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { listAgentFiles, readSavedAgentFile, readThreadAgent } from "@/client/api/agents-api";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";
import { projectReadEnabled } from "./project-read-gate";
import { agentCatalogQueryKey } from "./useAgentCatalog";
import { useProjectTreeViews } from "./useProjectTree";

const AGENTS_SCHEMES = ["agents", "user"] as const;

const agentFilesKey = (projectId: string) => ["projects", projectId, "agent-files"] as const;

export function useAgentFiles(projectId: string): AgentFiles | null {
  const accountId = useAccountId();
  const accountSignal = useAccountEpochSignal();
  const trees = useProjectTreeViews(projectId, AGENTS_SCHEMES, {});
  const project = trees.agents.tree;
  const user = trees.user.tree;
  const files = useMemo(
    () =>
      [project, user]
        .flatMap((tree) =>
          (tree?.files() ?? []).flatMap((file) => {
            const scheme = tree === project ? "agents" : "user";
            const at = agentsLocationOf(scheme, file.path.slice(1));
            return at ? [`${at.level}:${at.path}:${file.documentId}`] : [];
          }),
        )
        .sort()
        .join("|"),
    [project, user],
  );
  const query = useQuery({
    queryKey: [...agentFilesKey(projectId), accountId, files],
    queryFn: ({ signal }) => listAgentFiles(AbortSignal.any([accountSignal, signal]), projectId),
    enabled: projectReadEnabled(Boolean(projectId)),
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });
  return query.data ?? null;
}

export async function invalidateAgentReads(
  queryClient: QueryClient,
  projectId: string,
  accountId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: agentFilesKey(projectId) }),
    queryClient.invalidateQueries({ queryKey: agentCatalogQueryKey(accountId, projectId) }),
    queryClient.invalidateQueries({ queryKey: agentCatalogQueryKey(accountId) }),
  ]);
}

export function latestAgentFiles(queryClient: QueryClient, projectId: string): AgentFiles | null {
  const [latest] = queryClient
    .getQueryCache()
    .findAll({ queryKey: agentFilesKey(projectId) })
    .filter((query) => query.state.data !== undefined)
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
  return (latest?.state.data as AgentFiles | undefined) ?? null;
}

export function useSavedAgentFile(
  file: { projectId?: string; level: AgentLevel; path: string; saveId: string | null } | null,
) {
  const accountSignal = useAccountEpochSignal();
  const accountId = useAccountId();
  return useQuery({
    queryKey: ["agent-saved-file", accountId, file],
    queryFn: ({ signal }) =>
      readSavedAgentFile(
        AbortSignal.any([accountSignal, signal]),
        file ?? { level: "builtin", path: "" },
      ),
    enabled: file !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useThreadAgent(threadId: string | null) {
  const accountSignal = useAccountEpochSignal();
  const accountId = useAccountId();
  return useQuery({
    queryKey: ["thread-agent", accountId, threadId],
    queryFn: ({ signal }) =>
      readThreadAgent(AbortSignal.any([accountSignal, signal]), threadId ?? ""),
    enabled: threadId !== null,
    staleTime: 0,
  });
}
