/** Rail switches transfer the document in front, without synchronizing the two slot owners. */
import type { FolderNamespaceRecord, ResourceRecord } from "@meridian/resource-replica";
import type { ContextTab } from "@/client/stores";
import { projectResourceTab } from "../context/context-tab-from-file";
import { useProjectSurfacePrefsStore } from "../layout/surface-prefs-store";
import type { ScreenKey } from "../shell/screens";
import { dockDocumentOnScreen, useDockViewStore } from "./dock-view-store";
import { commitDockDocument } from "./use-dock-placement";

export function handOffVisibleDocument({
  projectId,
  source,
  destination,
  phone,
  editorTab,
  records,
  folders,
  revealDock,
}: {
  projectId: string;
  source: ScreenKey;
  destination: ScreenKey;
  phone: boolean;
  editorTab: ContextTab | null;
  records: readonly ResourceRecord[];
  folders: readonly FolderNamespaceRecord[];
  revealDock: (view: "document") => void;
}): { tab: ContextTab; commit: () => void } | undefined {
  if (phone || source === destination || destination === "work") return;
  const dock = useDockViewStore.getState();
  const occupant = dockDocumentOnScreen(dock.occupant, source, projectId);
  const tab =
    source === "context"
      ? editorTab
      : !useProjectSurfacePrefsStore.getState().slotPrefs.dock.collapsed && occupant
        ? occupant.tab
        : null;
  if (!tab) return;
  const projection = projectResourceTab(projectId, tab, records, folders);
  if (projection.kind === "removed" || projection.kind === "terminal") return;
  const visible = projection.kind === "projected" ? projection.tab : tab;
  // Claim now, but do not change the visible slot until history accepts the destination.
  const claim = dock.claim();
  return {
    tab: visible,
    commit: () => {
      if (!useDockViewStore.getState().isCurrent(claim)) return;
      if (destination === "chat") {
        commitDockDocument(projectId, "chat", visible, revealDock, claim);
      } else {
        useDockViewStore.getState().closeDocument();
      }
    },
  };
}
