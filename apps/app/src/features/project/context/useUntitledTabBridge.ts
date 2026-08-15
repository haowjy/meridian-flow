/** Bridges background untitled reconciliation receipts into the open-tab store. */
import { useEffect } from "react";
import { type ContextTab, useContextTabsActions, useContextTabsStore } from "@/client/stores";
import type { ContextRouteTarget } from "../routing/project-route";
import {
  isUntitledPending,
  registerUntitledCandidate,
  syncUntitledReceiptOwners,
} from "./untitled-reconciler-browser";

export function useUntitledTabBridge({
  projectId,
  tabs,
  onOpenContextTarget,
}: {
  projectId: string;
  tabs: ContextTab[];
  onOpenContextTarget: (target: ContextRouteTarget) => void;
}): void {
  const { remintNewTab, materializeNewTab, updateTrackedTab } = useContextTabsActions();

  useEffect(() => {
    syncUntitledReceiptOwners();
    const cleanups = tabs
      .filter(
        (tab) =>
          tab.kind === "new" ||
          (tab.kind === "tracked" && tab.provisionalName && isUntitledPending(tab.documentId)),
      )
      .map((tab) =>
        registerUntitledCandidate(tab.documentId, {
          onReminted: (documentId) => remintNewTab(projectId, tab.documentId, documentId),
          onMaterialized: (result) => {
            const slice = useContextTabsStore.getState().byProject[projectId];
            if (!slice?.tabs.some((candidate) => candidate.documentId === tab.documentId)) return;
            materializeNewTab(projectId, tab.documentId, {
              kind: "tracked",
              documentId: tab.documentId,
              scheme: result.scheme,
              path: result.path,
              name: result.name,
              workId: result.workId,
              editable: true,
              filetype: "markdown",
              schemaType: "document",
              provisionalName: true,
            });
            if (slice.activeTabId === tab.documentId) {
              onOpenContextTarget({
                path: result.path,
                scheme: result.scheme,
                workId: result.workId ?? null,
              });
            }
          },
          onIdentityCommitted: (result) => {
            updateTrackedTab(projectId, tab.documentId, {
              scheme: result.scheme,
              path: result.path,
              name: result.name,
              workId: result.workId,
              provisionalName: false,
            });
            if (
              useContextTabsStore.getState().byProject[projectId]?.activeTabId === tab.documentId
            ) {
              onOpenContextTarget({
                path: result.path,
                scheme: result.scheme,
                workId: result.routeWorkId,
              });
            }
          },
        }),
      );
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [materializeNewTab, onOpenContextTarget, projectId, remintNewTab, tabs, updateTrackedTab]);
}
