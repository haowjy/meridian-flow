import { parseRequestId } from "@meridian/contracts/request-id";
import type { RouteWorkResolution } from "../routing/project-route";

/** The stable identifier of the Work a route addresses: resolved, being created, or UUID-addressed. */
export function routeWorkIdentity(routeWork: RouteWorkResolution): string | null {
  if (routeWork.status === "present" || routeWork.status === "creating") return routeWork.workId;
  if (routeWork.status === "unresolved") return parseRequestId(routeWork.slug);
  return null;
}
