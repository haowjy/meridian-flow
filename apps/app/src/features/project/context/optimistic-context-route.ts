/**
 * Decides whether a route-known document should occupy the editor while its
 * durable tab is being materialized from the context tree.
 */
export type ContextRouteResolution = "loading" | "found" | "missing";

export function shouldShowOptimisticContextRoute({
  hasDestination,
  hasActiveTab,
  resolution,
  autoOpenBlocked,
}: {
  hasDestination: boolean;
  hasActiveTab: boolean;
  resolution: ContextRouteResolution;
  autoOpenBlocked: boolean;
}): boolean {
  if (!hasDestination || hasActiveTab || autoOpenBlocked) return false;
  return resolution === "loading" || resolution === "found";
}
