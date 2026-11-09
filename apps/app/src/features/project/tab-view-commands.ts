/**
 * The writer's version choice for a document's tab. Picking Live is a view change on the tab (it
 * also ends a review pin); the review controller follows the tab, so nothing here exits a review.
 */
import { getContextTabs, tabKey, useContextTabsStore } from "@/client/stores";

export function showDocumentLive(projectId: string, documentId: string): void {
  const tab = getContextTabs(projectId).tabs.find(
    (candidate) => candidate.documentId === documentId,
  );
  if (tab)
    useContextTabsStore
      .getState()
      .setTabState(projectId, tabKey(tab), { view: { version: "live" } });
}
