/**
 * The tab store's open documents, as the dock reads them: the selected tab, and closing one. What
 * a document paints is its view's (`views.ts`), not its tab's.
 */
import { useMemo } from "react";
import { type ContextTab, getContextTabs, tabKey, useSelectedContextTab } from "@/client/stores";
import { useContextRemovalCoordinator } from "@/features/project/context/account-feature-context";
import { settleWriterClose } from "@/features/project/context/use-follow-open-document-placement";

export type OpenDocumentTab = {
  /** Stable: `tabInstanceId ?? documentId`. */
  key: string;
  tab: ContextTab;
};

/** The selected tab only: the document surface re-renders for its tab, not for the strip. */
export function useSelectedOpenDocument(projectId: string): OpenDocumentTab | null {
  const tab = useSelectedContextTab(projectId);
  return useMemo(() => (tab ? { key: tabKey(tab), tab } : null), [tab]);
}

export function useOpenDocumentActions(projectId: string): { close(key: string): void } {
  const coordinator = useContextRemovalCoordinator();
  return useMemo(
    () => ({
      close: (key: string) => {
        const tab = getContextTabs(projectId).tabs.find((t) => tabKey(t) === key);
        if (tab) settleWriterClose(coordinator.writerClose(projectId, tab));
      },
    }),
    [projectId, coordinator],
  );
}
