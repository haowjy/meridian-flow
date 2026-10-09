/** Rail switches transfer the document in front, without synchronizing the two slot owners. */
import type { FolderNamespaceRecord, ResourceRecord } from "@meridian/resource-replica";
import type { ContextTab } from "@/client/stores";
import { projectResourceTab } from "../context/context-tab-from-file";
import { useProjectSurfacePrefsStore } from "../layout/surface-prefs-store";
import type { ScreenKey } from "../shell/screens";
import { useDockViewStore } from "./dock-view-store";
import { commitDockDocument } from "./use-dock-placement";

export function handOffVisibleDocument<T>({
  projectId,
  source,
  destination,
  phone,
  editorTab,
  records,
  folders,
  revealDock,
  openInEditor,
}: {
  projectId: string;
  source: ScreenKey;
  destination: ScreenKey;
  phone: boolean;
  editorTab: ContextTab | null;
  records: readonly ResourceRecord[];
  folders: readonly FolderNamespaceRecord[];
  revealDock: (view: "document") => void;
  openInEditor: (tab: ContextTab) => T;
}): T | undefined {
  if (phone || source === destination) return;
  const dock = useDockViewStore.getState();
  const occupant = dock.occupant;
  const tab =
    source === "context"
      ? editorTab
      : !useProjectSurfacePrefsStore.getState().slotPrefs.dock.collapsed &&
          occupant?.projectId === projectId &&
          occupant.screen === source
        ? occupant.tab
        : null;
  if (!tab) return;
  const projection = projectResourceTab(projectId, tab, records, folders);
  if (projection.kind === "removed" || projection.kind === "terminal") return;
  const visible = projection.kind === "projected" ? projection.tab : tab;
  if (destination === "chat") {
    commitDockDocument(projectId, "chat", visible, revealDock);
  } else if (destination === "context") {
    dock.closeDocument();
    return openInEditor(visible);
  }
  // Work keeps its chat beside it, never receives a document from another screen.
}
