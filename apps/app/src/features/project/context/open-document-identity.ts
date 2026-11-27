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

export function routeTargetForTab(tab: OpenDocument): ContextRouteRequest {
  if (tab.kind === "new") return { scheme: "unfiled", path: "", documentId: tab.documentId };
  if (isWorkScopedScheme(tab.scheme) && !tab.rootThreadId && !tab.workId)
    throw new Error("Work-scoped tab has no Work owner");
  return contextRouteRequest(tab);
}
