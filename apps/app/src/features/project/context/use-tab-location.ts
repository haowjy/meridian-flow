/** Visible tab ancestry follows catalog identities; paths remain mutation coordinates. */
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { type ContextTab, tabContextOwner } from "@/client/stores";
import { tabLocation } from "./identity-location";

export function useTabLocation(projectId: string, tab: ContextTab) {
  const { catalog } = useContextCatalogView(
    projectId,
    tab.kind === "new" ? "unfiled" : tab.scheme,
    tab.kind === "new" ? { enabled: false } : tabContextOwner(tab),
  );
  const file = tab.kind === "new" ? null : catalog?.findDocument(tab.documentId);
  return tabLocation(tab, file?.parentLabels);
}
