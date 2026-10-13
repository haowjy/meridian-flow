/** Restores a hidden dock candidate only after replica hydration and identity validation. */

import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import {
  type DocumentAddressResult,
  isProjectContextTreeScheme,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { resourcePlacementForSnapshot, resourceVisibleInProject } from "@meridian/resource-replica";

import { useEffect, useLayoutEffect } from "react";
import { getProjectDocumentAddress } from "@/client/api/projects-api";
import { contextCatalogScope } from "@/client/query/useContextCatalog";

import type { ContextTab } from "@/client/stores";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import { validateServerRoute } from "../browser-editor-tab-validation";
import { useAccountId, useAccountResourceReplica } from "../context/account-feature-context";
import { workingSetRouteForTab } from "../context/context-removal-planner";

import { projectResourceTab } from "../context/context-tab-from-file";
import { type DockDocument, useDockDocumentStore } from "./dock-document-store";

type ReviewSelector = { workId: string; itemKey: string };

export type DockRestorePorts = {
  resources: Pick<AccountResourceReplica, "readProjection" | "acquireCatalog">;
  /** Asks the server selector for the saved review's document: the only authority for it. */
  admitReview: (
    projectId: string,
    review: ReviewSelector,
    locator: { scheme: ProjectContextTreeScheme; path: string },
  ) => Promise<DocumentAddressResult>;
};

/**
 * A saved review asks the server selector with its `{ workId, itemKey }` before any list or
 * catalog restoration. An unavailable answer keeps the saved address for the pane to show; an
 * omitted list row never turns a review into Live.
 */
export async function restoreDockDocument(
  document: DockDocument,
  { resources, admitReview }: DockRestorePorts,
): Promise<DockDocument | null> {
  const { review } = document;
  if (!review || document.tab.kind === "new") {
    const tab = await restoreLiveTab(document, resources);
    return tab ? { ...document, tab, review } : null;
  }
  const { tab } = document;
  let answer: DocumentAddressResult;
  try {
    answer = await admitReview(document.projectId, review, { scheme: tab.scheme, path: tab.path });
  } catch {
    return { ...document, reviewAdmission: "failed" };
  }
  if (answer.kind === "unavailable") return { ...document, reviewAdmission: "unavailable" };
  const entry = answer.document.entry;
  const uri = parseUnifiedContextUri(entry.uri);
  if (!uri.ok || !isProjectContextTreeScheme(uri.value.scheme))
    return { ...document, reviewAdmission: "unavailable" };
  // The selector proves review addressability, never catalog membership. Restore the admitted
  // identity and canonical locator without waiting for a list or installing a live representation.
  return {
    ...document,
    reviewAdmission: "admitted",
    tab: {
      ...tab,
      documentId: answer.document.documentId,
      scheme: uri.value.scheme,
      path: `/${entry.path.join("/")}`,
      name: entry.name,
    },
  };
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
      resourcePlacementForSnapshot(projectId, snapshot),
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
  const next = projectResourceTab(
    projectId,
    validated,
    current.records,
    resourcePlacementForSnapshot(projectId, current),
  );
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
      admitReview: (project, review, locator) =>
        getProjectDocumentAddress(project, locator.scheme, locator.path, { review }),
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
  }, [accountId, storedAccountId, workspaceHydrated, restoring, resources, projectId]);
}
