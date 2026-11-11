/** Project a live editor tab into an account-recents opening. Local untitled documents keep their resource handle. */
import { PROJECT_SCOPED_CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import type { RecentAddress, RecentOpening } from "@/client/recents";
import { readableRecentPath } from "@/client/recents";
import type { ContextTab } from "@/client/stores";

const EDITOR_SCHEMES = new Set<string>(PROJECT_SCOPED_CONTEXT_URI_SCHEMES);

export function recentOpening(
  projectId: string,
  tab: ContextTab,
  openedAt: string,
  /** Live lacks the document (`useDocumentLiveness`): a draft-only review is never a live recent. */
  draftOnly: boolean,
): RecentOpening | null {
  if (tab.kind === "new") {
    if (!tab.resourceHandle) return null;
    return {
      documentId: tab.documentId,
      projectId,
      name: tab.name,
      openedAt,
      address: { kind: "local", resourceHandle: tab.resourceHandle },
    };
  }
  if (draftOnly || !EDITOR_SCHEMES.has(tab.scheme)) return null;
  const path = readableRecentPath(tab.path);
  if (!path) return null;
  const address: RecentAddress = {
    kind: "document",
    scheme: tab.scheme,
    path: `/${path}`,
  };
  return { documentId: tab.documentId, projectId, name: tab.name, openedAt, address };
}

export function recentAddressFromTab(tab: ContextTab, draftOnly: boolean): RecentAddress | null {
  return recentOpening("", tab, "", draftOnly)?.address ?? null;
}
