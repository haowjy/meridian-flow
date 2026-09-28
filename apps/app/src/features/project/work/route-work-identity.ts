import { parseRequestId } from "@meridian/contracts/request-id";
import type { RouteWorkResolution } from "../routing/project-route";

/** The stable identifier represented by a resolved or UUID-addressed Work route. */
export function routeWorkIdentity(routeWork: RouteWorkResolution): string | null {
  if (routeWork.status === "present") return routeWork.workId;
  if (routeWork.status === "unresolved") return parseRequestId(routeWork.slug);
  return null;
}
