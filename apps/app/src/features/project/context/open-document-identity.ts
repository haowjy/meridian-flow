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
import { type ContextRouteRequest, contextRouteRequest } from "../routing/project-route";

type RouteLocator = Pick<ContextRouteRequest, "scheme" | "path" | "workId" | "rootThreadId">;

export function openDocumentMatchesRoute(tab: OpenDocument, target: RouteLocator): boolean {
  if (tab.kind === "new") return false;
  if (tab.scheme !== target.scheme || tab.path !== target.path) return false;
  if (!isWorkScopedScheme(target.scheme)) return true;
  return target.rootThreadId !== undefined
    ? tab.rootThreadId === target.rootThreadId
    : tab.rootThreadId === undefined && tab.workId === target.workId;
}

/** The locator a tab is shown at. */
export function routeTargetForTab(tab: OpenDocument): ContextRouteRequest {
  if (tab.kind === "new") return { scheme: "unfiled", path: "", documentId: tab.documentId };
  if (isWorkScopedScheme(tab.scheme) && !tab.rootThreadId && !tab.workId)
    throw new Error("Work-scoped tab has no Work owner");
  return contextRouteRequest(tab);
}
