/** Exact, heuristic-free resolution of the Editor workspace owner for one committed route. */

import { isEditorOpenDocument, type OpenDocument } from "@/client/stores";
import type { ContextRouteRequest } from "../routing/project-route";
import { type ContextRouteIdentity, routeTargetForTab } from "./context-removal-planner";
import { openDocumentMatchesRoute } from "./open-document-identity";

export type WorkspaceRouteResolution =
  | { kind: "owner"; tab: OpenDocument; identity: ContextRouteIdentity }
  | {
      kind: "materialized-local";
      tab: Extract<OpenDocument, { kind: "tracked" }>;
      target: ContextRouteRequest;
    }
  | { kind: "unowned" };

/**
 * Whether main's document owns the route: by its path, or, for the pointer route (`unfiled`, no
 * path), as the local document the pointer holds.
 */
export function resolveWorkspaceRoute(
  document: OpenDocument,
  locator: ContextRouteRequest | null,
): WorkspaceRouteResolution {
  if (!locator || !isEditorOpenDocument(document)) return { kind: "unowned" };
  if (document.kind !== "new" && openDocumentMatchesRoute(document, locator))
    return {
      kind: "owner",
      tab: document,
      identity: { kind: "server", documentId: document.documentId },
    };
  if (locator.scheme !== "unfiled" || locator.path !== "") return { kind: "unowned" };
  if (document.kind === "new")
    return {
      kind: "owner",
      tab: document,
      identity: { kind: "local", documentId: document.documentId },
    };
  if (document.kind === "tracked" && document.origin === "local-resource")
    return { kind: "materialized-local", tab: document, target: routeTargetForTab(document) };
  return { kind: "unowned" };
}
