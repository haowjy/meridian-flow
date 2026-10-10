/** Restores a hidden dock candidate only after replica hydration and identity validation. */

import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { resourceVisibleInProject } from "@meridian/resource-replica";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect } from "react";
import { contextCatalogScope } from "@/client/query/useContextCatalog";
import { workDraftsQueryOptions } from "@/client/query/useWorkDrafts";
import type { ContextTab } from "@/client/stores";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import { validateServerRoute } from "../browser-editor-tab-validation";
import { useAccountId, useAccountResourceReplica } from "../context/account-feature-context";
import { workingSetRouteForTab } from "../context/context-removal-planner";
import { contextTabFromDraftGroup } from "../context/context-tab-from-draft";
import { projectResourceTab } from "../context/context-tab-from-file";
import { type DockDocument, useDockDocumentStore } from "./dock-document-store";

export async function restoreDockDocument(
  document: DockDocument,
  {
    resources,
    readWorkDrafts,
  }: {
    resources: Pick<AccountResourceReplica, "readProjection" | "acquireCatalog">;
    readWorkDrafts: (projectId: string, workId: string) => Promise<ThreadDraftListItem[]>;
  },
): Promise<DockDocument | null> {
  let review = document.review;
  if (review) {
    const rows = await readWorkDrafts(document.projectId, review.workId);
    const row = rows.find(
      (row) => row.draftId === review?.draftId && row.documentId === document.tab.documentId,
    );
    if (row?.isNewDocument) {
      const tab = contextTabFromDraftGroup({ ...row, workId: review.workId });
      return tab ? { ...document, tab, review } : null;
    }
    if (!row) review = null;
  }
  const tab = await restoreLiveTab(document, resources);
  return tab ? { ...document, tab, review } : null;
}

async function restoreLiveTab(
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
  if (scope) {
    const catalog = await resources.acquireCatalog(projectId, scope);
    // Availability can still resolve a discarded draft's reserved document ID.
    // Only catalog membership proves a server-backed tab is live, including
    // a saved draft-only tab that has already lost its review address.
    if (catalog.entries.get(validated.documentId)?.kind !== "file") return null;
  }
  const current = await resources.readProjection(projectId);
  const next = projectResourceTab(projectId, validated, current.records, current.folders);
  if (next.kind === "removed" || next.kind === "terminal") return null;
  return next.kind === "projected" ? next.tab : validated;
}

/** Dock-owned effect shell; the project supplies only its identity and Editor hydration signal. */
export function useDockDocumentRestoration(projectId: string, workspaceHydrated: boolean): void {
  const accountId = useAccountId();
  useLayoutEffect(() => {
    useDockDocumentStore.getState().rehydrate(accountId);
  }, [accountId]);
  const storedAccountId = useDockDocumentStore((state) => state.accountId);
  const restoring = useDockDocumentStore((state) => state.restoring);
  const resources = useAccountResourceReplica();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (
      storedAccountId !== accountId ||
      !workspaceHydrated ||
      !restoring ||
      restoring.projectId !== projectId
    )
      return;
    let live = true;
    void restoreDockDocument(restoring, {
      resources,
      readWorkDrafts: (project, work) =>
        queryClient.fetchQuery(workDraftsQueryOptions(project, work)),
    }).then(
      (tab) => {
        if (live) useDockDocumentStore.getState().restore(restoring, tab);
      },
      () => {
        // Read degradation is not proof of deletion. Keep the hidden candidate for reload/retry.
      },
    );
    return () => {
      live = false;
    };
  }, [accountId, storedAccountId, workspaceHydrated, restoring, resources, projectId, queryClient]);
}
