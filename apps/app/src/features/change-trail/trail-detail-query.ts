/** Shared read policy for durable change-trail detail. */
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { changeTrailDetailKey, readChangeTrail } from "@/client/change-trails";

/**
 * One cache entry per (thread, trail), shared by every surface that renders
 * trail evidence — receipt rows and the anchored peer-mark popover.
 *
 * Settled trail evidence does not change on its own, so a re-open is not a
 * freshness event and must not refetch: that is what made the popover open
 * empty. A bumped shell version or lost document access invalidates the cache.
 * Retention past the last observer is React Query's default garbage window,
 * so evidence for a document whose access is later revoked cannot linger.
 */
export function changeTrailDetailQuery(threadId: string, trailId: string) {
  return queryOptions({
    queryKey: changeTrailDetailKey(threadId, trailId),
    queryFn: () => readChangeTrail(threadId, trailId),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 2,
  });
}

export type TrailDetailTarget = { threadId: string; trailId: string };

/**
 * Warm the detail cache for trails whose marks are already on screen, so the
 * popover opens with its evidence rather than filling in after the click.
 */
export function usePrefetchTrailDetails(targets: readonly TrailDetailTarget[]): void {
  const queryClient = useQueryClient();
  // Key the effect on the target set, not the array reference: callers derive
  // targets from a live marker snapshot that changes identity on every write.
  const identity = [...new Set(targets.map(targetKey))].sort().join(TARGET_SEPARATOR);
  useEffect(() => {
    for (const key of identity ? identity.split(TARGET_SEPARATOR) : []) {
      const [threadId, trailId] = key.split(FIELD_SEPARATOR);
      if (!threadId || !trailId) continue;
      void queryClient.prefetchQuery(changeTrailDetailQuery(threadId, trailId));
    }
  }, [identity, queryClient]);
}

const TARGET_SEPARATOR = "\u0001";
const FIELD_SEPARATOR = "\u0000";

function targetKey(target: TrailDetailTarget): string {
  return `${target.threadId}${FIELD_SEPARATOR}${target.trailId}`;
}
