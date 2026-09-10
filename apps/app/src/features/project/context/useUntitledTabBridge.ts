/** Bridges background untitled reconciliation receipts into the open-tab store. */
import { useEffect, useRef } from "react";
import {
  type ContextTab,
  publishLocalUntitledAdoption,
  useContextTabsActions,
  useContextTabsStore,
} from "@/client/stores";
import type { LiveDocumentBinding } from "./open-project-document";
import {
  isUntitledPending,
  registerUntitledCandidate,
  syncUntitledReceiptOwners,
} from "./untitled-reconciler-browser";

export function useUntitledTabBridge({
  projectId,
  tabs,
}: {
  projectId: string;
  tabs: ContextTab[];
}): void {
  const { remintNewTab } = useContextTabsActions();
  const adoptedBindings = useRef(new Map<string, LiveDocumentBinding>());

  useEffect(() => {
    const present = new Set(tabs.map((tab) => tab.documentId));
    for (const [documentId, binding] of adoptedBindings.current) {
      if (present.has(documentId)) continue;
      binding.release();
      adoptedBindings.current.delete(documentId);
    }
  }, [tabs]);

  useEffect(
    () => () => {
      for (const binding of adoptedBindings.current.values()) binding.release();
      adoptedBindings.current.clear();
    },
    [],
  );

  useEffect(() => {
    syncUntitledReceiptOwners();
    const cleanups = tabs
      .filter(
        (tab) =>
          tab.kind === "new" ||
          (tab.kind === "tracked" &&
            tab.provisionalName &&
            isUntitledPending(projectId, tab.documentId)),
      )
      .map((tab) =>
        registerUntitledCandidate(projectId, tab.documentId, {
          onReminted: (documentId) => remintNewTab(projectId, tab.documentId, documentId),
          onMaterialized: async ({ result, identity, binding }) => {
            const slice = useContextTabsStore.getState().byProject[projectId];
            if (!slice?.tabs.some((candidate) => candidate.documentId === tab.documentId)) {
              binding?.release();
              return true;
            }
            if (tab.kind !== "new" || !tab.lineageHandle) {
              binding?.release();
              return false;
            }
            const trackedTab: ContextTab = {
              kind: "tracked",
              documentId: tab.documentId,
              scheme: identity?.scheme ?? result.scheme,
              path: identity?.path ?? result.path,
              name: identity?.name ?? result.name,
              workId: identity?.workId ?? result.workId ?? undefined,
              editable: true,
              filetype: "markdown",
              schemaType: "document",
              provisionalName: !identity,
              origin: "local-untitled",
            };
            const published = await publishLocalUntitledAdoption({
              lineageHandle: tab.lineageHandle,
              adoptionRevision: (tab.identityRevision ?? 1) + 1,
              trackedTab,
            });
            if (published === "stale") {
              binding?.release();
              return false;
            }
            if (binding) {
              adoptedBindings.current.get(tab.documentId)?.release();
              adoptedBindings.current.set(tab.documentId, binding);
            }
            return true;
          },
        }),
      );
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [projectId, remintNewTab, tabs]);
}
