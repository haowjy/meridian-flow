/** What Mars made of each Agent and skill file at every level, for the Agents tab and an open file. */
import { type AgentFileStatus, agentsLocationOf } from "@meridian/contracts/agents";
import { keepPreviousData, type QueryClient, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { listAgentFiles, readBuiltinAgentFile } from "@/client/api/agents-api";
import { projectReadEnabled } from "@/client/creation/project-read-gate";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";
import { agentCatalogQueryKey } from "./useAgentCatalog";
import { useProjectTreeViews } from "./useProjectTree";

const AGENTS_SCHEMES = ["agents", "user"] as const;

const agentFilesKey = (projectId: string) => ["projects", projectId, "agent-files"] as const;

/**
 * Keyed on the documents in both Agents locations as the trees have them: a file made, renamed
 * or deleted asks again, and the last answer stays on screen meanwhile.
 */
export function useAgentFiles(projectId: string): AgentFileStatus[] | null {
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

/** An Agent file's text changed on the server: the verdicts and the picker read it again. */
export function invalidateAgentReads(
  queryClient: QueryClient,
  projectId: string,
  accountId: string,
) {
  void queryClient.invalidateQueries({ queryKey: agentFilesKey(projectId) });
  void queryClient.invalidateQueries({ queryKey: agentCatalogQueryKey(accountId, projectId) });
}

export function useBuiltinAgentFile(path: string | null) {
  const accountSignal = useAccountEpochSignal();
  return useQuery({
    queryKey: ["agent-builtin", path],
    queryFn: ({ signal }) =>
      readBuiltinAgentFile(AbortSignal.any([accountSignal, signal]), path ?? ""),
    enabled: path !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
