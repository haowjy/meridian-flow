/** The sources the account can read: the roots of the project's tree list, and the account's own (`user://`). */
import type { ContextSource, ContextSourcesResult } from "@meridian/contracts/protocol";
import { skipToken, useQuery } from "@tanstack/react-query";
import { getAccountContextSources, getProjectContextSources } from "@/client/api/projects-api";
import { projectQueryKeys } from "./project-query-keys";

/** A source query's answer, or undefined until it has come. */
export function useProjectContextSources(projectId: string): readonly ContextSource[] | undefined {
  return useQuery<ContextSourcesResult>({
    queryKey: projectQueryKeys.contextSources(projectId),
    queryFn: projectId ? ({ signal }) => getProjectContextSources(projectId, signal) : skipToken,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  }).data?.sources;
}

export function useAccountContextSources(enabled = true): readonly ContextSource[] | undefined {
  return useQuery<ContextSourcesResult>({
    queryKey: projectQueryKeys.accountContextSources(),
    queryFn: enabled ? ({ signal }) => getAccountContextSources(signal) : skipToken,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  }).data?.sources;
}
