import { PROJECT_SCOPED_CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import type { RecentAddress, RecentOpening } from "@/client/recents";
import { readableRecentPath } from "@/client/recents";
import type { OpenDocument } from "@/client/stores";

const EDITOR_SCHEMES = new Set<string>(PROJECT_SCOPED_CONTEXT_URI_SCHEMES);

export function recentOpening(
  projectId: string,
  tab: OpenDocument,
  openedAt: string,
): RecentOpening | null {
  if (tab.kind === "new") return null;
  if (!EDITOR_SCHEMES.has(tab.scheme)) return null;
  const path = readableRecentPath(tab.path);
  if (!path) return null;
  const address: RecentAddress = {
    kind: "document",
    scheme: tab.scheme,
    path: `/${path}`,
  };
  return { documentId: tab.documentId, projectId, name: tab.name, openedAt, address };
}

export function recentAddressFromTab(tab: OpenDocument): RecentAddress | null {
  return recentOpening("", tab, "")?.address ?? null;
}
