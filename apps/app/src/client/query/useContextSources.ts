/** The sources the account can read: the roots of the project's tree list, and the account's own (`user://`). */
import type { ContextSource, ContextSourcesResult } from "@meridian/contracts/protocol";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getAccountContextSources, getProjectContextSources } from "@/client/api/projects-api";
import { projectQueryKeys } from "./project-query-keys";

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
    queryFn: projectId ? ({ signal }) => getProjectContextSources(projectId, signal) : skipToken,
    ...FRESHNESS,
  });
}

function useAccountContextSourcesResult(enabled = true) {
  return useQuery<ContextSourcesResult>({
    queryKey: projectQueryKeys.accountContextSources(),
    queryFn: enabled ? ({ signal }) => getAccountContextSources(signal) : skipToken,
    ...FRESHNESS,
  });
}

/** A source query's answer, or undefined until it has come. */
export function useProjectContextSources(projectId: string): readonly ContextSource[] | undefined {
  return useProjectContextSourcesResult(projectId).data?.sources;
}

export function useAccountContextSources(enabled = true): readonly ContextSource[] | undefined {
  return useAccountContextSourcesResult(enabled).data?.sources;
}

/** What both queries said of every source, and the time of the older answer; null until both have come. */
export function useContextSourceFacts(projectId: string) {
  const project = useProjectContextSourcesResult(projectId);
  const account = useAccountContextSourcesResult();
  const { data: mine, dataUpdatedAt: projectAt } = project;
  const { data: yours, dataUpdatedAt: accountAt } = account;
  return useMemo(
    () =>
      mine && yours
        ? {
            live: new Set([...mine.sources, ...yours.sources].map((source) => source.id as string)),
            ended: new Set([...mine.ended, ...yours.ended] as string[]),
            fetchedAt: Math.min(projectAt, accountAt),
          }
        : null,
    [mine, yours, projectAt, accountAt],
  );
}
