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
          onMaterialized: ({ result, identity }) => {
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
            if (identity) {
              updateTrackedTab(projectId, tab.documentId, {
                scheme: identity.scheme,
                path: identity.path,
                name: identity.name,
                workId: identity.workId,
                provisionalName: false,
              });
            }
            if (slice.activeTabId === tab.documentId) {
              const settled = identity ?? result;
              onOpenContextTarget({
                path: settled.path,
                scheme: settled.scheme,
                workId: identity?.routeWorkId ?? result.workId ?? null,
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
