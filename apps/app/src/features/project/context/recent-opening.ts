/** Project a live editor tab into an account-recents opening. Local drafts keep their resource handle. */
import { PROJECT_SCOPED_CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import type { RecentAddress, RecentOpening } from "@/client/recents";
import { readableRecentPath } from "@/client/recents";
import type { ContextTab } from "@/client/stores";

const EDITOR_SCHEMES = new Set<string>(PROJECT_SCOPED_CONTEXT_URI_SCHEMES);

export function recentOpening(
  projectId: string,
  tab: ContextTab,
  openedAt: string,
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
  if (!EDITOR_SCHEMES.has(tab.scheme)) return null;
  const path = readableRecentPath(tab.path);
  if (!path) return null;
  const address: RecentAddress = {
    kind: "document",
    scheme: tab.scheme,
    path: `/${path}`,
    workId: isWorkScopedProjectContextScheme(tab.scheme) ? (tab.workId ?? null) : null,
    workSlug: null,
  };
  return { documentId: tab.documentId, projectId, name: tab.name, openedAt, address };
}

export function recentAddressFromTab(tab: ContextTab): RecentAddress | null {
  return recentOpening("", tab, "")?.address ?? null;
}
