/** Restores a hidden dock candidate only after replica hydration and identity validation. */
import { resourceVisibleInProject } from "@meridian/resource-replica";
import { contextCatalogScope } from "@/client/query/useContextCatalog";
import type { ContextTab } from "@/client/stores";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import { validateServerRoute } from "../browser-editor-tab-validation";
import { workingSetRouteForTab } from "../context/context-removal-planner";
import { projectResourceTab } from "../context/context-tab-from-file";
import type { DockDocument } from "./dock-view-store";

export async function restoreDockDocument(
  document: DockDocument,
  resources: Pick<AccountResourceReplica, "readProjection" | "acquireCatalog">,
): Promise<ContextTab | null> {
  const { projectId, tab } = document;
  // readProjection waits for IndexedDB, just like Editor workspace bootstrap.
  const snapshot = await resources.readProjection(projectId);
  const project = (candidate: ContextTab) =>
    projectResourceTab(
      projectId,
      candidate,
      snapshot.records.filter((record) =>
        resourceVisibleInProject(projectId, record, snapshot.catalogs),
      ),
      snapshot.folders,
    );
  const projection = project(tab);
  if (projection.kind === "removed" || projection.kind === "terminal") return null;
  const local = snapshot.records.find((record) => record.resource.handle === tab.resourceHandle);
  if (tab.kind === "new" || local?.resource.lifecycle.kind === "local")
    return projection.kind === "projected" ? projection.tab : null;
  const route = workingSetRouteForTab(tab);
  if (!route) return null;
  // A catalog-only document may never have been acquired into the replica.
  // Resolve its stable ID rather than trying the saved (possibly renamed) path.
  const validated = (await validateServerRoute(projectId, route)).tab;
  if (!validated || validated.kind === "new") return null;
  const scope = contextCatalogScope(projectId, validated.scheme, validated);
  if (scope) await resources.acquireCatalog(projectId, scope);
  const current = await resources.readProjection(projectId);
  const next = projectResourceTab(projectId, validated, current.records, current.folders);
  if (next.kind === "removed" || next.kind === "terminal") return null;
  return next.kind === "projected" ? next.tab : validated;
}
