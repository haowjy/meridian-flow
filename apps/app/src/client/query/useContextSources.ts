import type { ContextSource, ContextSourcesResult } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getAccountContextSources, getProjectContextSources } from "@/client/api/projects-api";
import { projectQueryKeys } from "./project-query-keys";
import { projectReadEnabled } from "./project-read-gate";

/**
 * A source ended while this browser was offline is learned on reconnect, whatever the age of the
 * answer: the hint that says so rides a subscription that was not there.
 */
const FRESHNESS = {
  staleTime: 30_000,
  refetchOnWindowFocus: true,
  refetchOnReconnect: "always",
} as const;

function useProjectContextSourcesResult(projectId: string) {
  return useQuery<ContextSourcesResult>({
    queryKey: projectQueryKeys.contextSources(projectId),
    queryFn: ({ signal }) => getProjectContextSources(projectId, signal),
    enabled: projectReadEnabled(Boolean(projectId)),
    ...FRESHNESS,
  });
}

function useAccountContextSourcesResult(enabled = true) {
  return useQuery<ContextSourcesResult>({
    queryKey: projectQueryKeys.accountContextSources(),
    queryFn: ({ signal }) => getAccountContextSources(signal),
    enabled,
    ...FRESHNESS,
  });
}

export function useProjectContextSources(projectId: string): readonly ContextSource[] | undefined {
  return useProjectContextSourcesResult(projectId).data?.sources;
}

export function useAccountContextSources(enabled = true): readonly ContextSource[] | undefined {
  return useAccountContextSourcesResult(enabled).data?.sources;
}

export function useEndedSources(projectId: string): ReadonlySet<string> | null {
  const { data: mine } = useProjectContextSourcesResult(projectId);
  const { data: yours } = useAccountContextSourcesResult();
  return useMemo(
    () => (mine && yours ? new Set<string>([...mine.ended, ...yours.ended]) : null),
    [mine, yours],
  );
}
