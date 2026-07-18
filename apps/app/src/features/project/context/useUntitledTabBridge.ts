/** Bridges background untitled reconciliation receipts into the open-tab store. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useEffect } from "react";
import { type ContextTab, useContextTabsActions, useContextTabsStore } from "@/client/stores";
import { isUntitledPending, registerUntitledCandidate } from "./untitled-reconciler-browser";

export function useUntitledTabBridge({
  projectId,
  tabs,
  defaultWorkId,
  onSelectContextPath,
}: {
  projectId: string;
  tabs: ContextTab[];
  defaultWorkId: string | null;
  onSelectContextPath: (path: string, scheme?: ProjectContextTreeScheme) => void;
}): void {
  const { remintNewTab, materializeNewTab, updateTrackedTab } = useContextTabsActions();

  useEffect(() => {
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
              onSelectContextPath(result.path, result.scheme);
            }
          },
          onIdentityCommitted: (result) => {
            updateTrackedTab(projectId, tab.documentId, {
              scheme: result.scheme,
              path: result.path,
              name: result.name,
              workId: result.scheme === "scratch" ? (defaultWorkId ?? undefined) : undefined,
              provisionalName: false,
            });
            if (
              useContextTabsStore.getState().byProject[projectId]?.activeTabId === tab.documentId
            ) {
              onSelectContextPath(result.path, result.scheme);
            }
          },
        }),
      );
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [
    defaultWorkId,
    materializeNewTab,
    onSelectContextPath,
    projectId,
    remintNewTab,
    tabs,
    updateTrackedTab,
  ]);
}
