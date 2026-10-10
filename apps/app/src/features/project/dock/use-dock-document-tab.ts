/** The dock document's tab as the resource projection now shows it, or null once it is gone. */
import type { ContextTab } from "@/client/stores";
import { useAccountResourceProjection } from "../context/account-feature-context";
import { projectResourceTab } from "../context/context-tab-from-file";
import type { DockDocument } from "./dock-view-store";

/**
 * The slot keeps the tab it was opened with. A rename or move elsewhere changes
 * the resource, not the slot, so the name and path shown always come from here.
 */
export function useDockDocumentTab(
  projectId: string,
  document: DockDocument,
): { tab: ContextTab; gone: boolean };
export function useDockDocumentTab(
  projectId: string,
  document: DockDocument | null,
): { tab: ContextTab | null; gone: boolean };
export function useDockDocumentTab(projectId: string, document: DockDocument | null) {
  const { records, folders } = useAccountResourceProjection(projectId);
  if (!document) return { tab: null, gone: false };
  const projection = projectResourceTab(projectId, document.tab, records, folders);
  if (projection.kind === "removed" || projection.kind === "terminal")
    return { tab: document.tab, gone: true };
  const tab: ContextTab = projection.kind === "projected" ? projection.tab : document.tab;
  return { tab, gone: false };
}
