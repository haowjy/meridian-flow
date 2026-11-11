/**
 * open-document-identity — route/tab matching for work-scoped context files.
 *
 * Scratch shares path shape across works and
 * a No Work chat's Scratch shares it across lineages; tab and route
 * reconciliation must include the owner (`workId` or `rootThreadId`) so
 * switching active work cannot reuse another owner's open tab.
 */
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type { OpenDocument } from "@/client/stores";
import type { ContextRouteRequest } from "../routing/project-route";

type RouteLocator = Pick<ContextRouteRequest, "scheme" | "path" | "workId" | "rootThreadId">;

export function openDocumentMatchesRoute(tab: OpenDocument, target: RouteLocator): boolean {
  if (tab.kind === "new") return false;
  if (tab.scheme !== target.scheme || tab.path !== target.path) return false;
  if (!isWorkScopedScheme(target.scheme)) return true;
  return target.rootThreadId !== undefined
    ? tab.rootThreadId === target.rootThreadId
    : tab.rootThreadId === undefined && tab.workId === target.workId;
}
