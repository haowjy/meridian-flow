/** The document the Chat screen's dock shows: the selected tab, as the resource projection places it. */
import { useAccountResourceProjection } from "../context/account-feature-context";
import { projectResourceTab } from "../context/context-tab-from-file";
import { useIsDraftOnly } from "../context/use-is-draft-only";
import { type OpenDocumentTab, useSelectedOpenDocument } from "../open-documents";
import type { ScreenKey } from "../routing/project-route";

/** A removed document is closed by the removal coordinator, which tells the writer why. */
export function useDockedDocument(projectId: string, screen: ScreenKey): OpenDocumentTab | null {
  const selected = useSelectedOpenDocument(projectId);
  const { records, placement } = useAccountResourceProjection(projectId);
  const isDraftOnly = useIsDraftOnly(projectId);
  if (screen !== "chat" || !selected) return null;
  const projected = projectResourceTab(
    projectId,
    selected.tab,
    records,
    placement,
    isDraftOnly(selected.tab.documentId),
  );
  if (projected.kind === "removed" || projected.kind === "terminal") return null;
  return projected.kind === "projected" ? { ...selected, tab: projected.tab } : selected;
}
