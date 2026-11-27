import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import {
  type ContextRouteRequest,
  contextRouteRequest,
} from "@/client/project-shell/project-route";
import type { OpenDocument } from "@/client/stores";

export function routeTargetForTab(tab: OpenDocument): ContextRouteRequest {
  if (tab.kind === "new") return { scheme: "unfiled", path: "", documentId: tab.documentId };
  if (isWorkScopedScheme(tab.scheme) && !tab.rootThreadId && !tab.workId)
    throw new Error("Work-scoped tab has no Work owner");
  return contextRouteRequest(tab);
}
