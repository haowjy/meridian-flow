/** Navigation chrome for an Editor address whose document is not yet displayable. */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isEditorTab, useContextTabs } from "@/client/stores";
import { useContextRemovalCoordinator } from "../context/account-feature-context";
import { ContextTabBar } from "../context/ContextTabBar";
import { schemeLabel } from "../context/context-schemes";
import { folderAncestry, pathLeafName } from "../mobile/context-location";
import { MobileBreadcrumb, type MobileBreadcrumbSegment } from "../mobile/MobileBreadcrumb";
import { PaneHeader, type PaneHeaderRailToggle } from "../shell/PaneHeader";
import { useOpenDocumentInEditor } from "./use-open-document-in-editor";

export function EditorRouteChrome({
  projectId,
  editorWorkId,
  onShowRecents,
  scheme,
  path,
  onShowFiles,
  onShowFolder,
  sidebarToggle,
  dockToggle,
}: {
  projectId: string;
  editorWorkId: string | null;
  onShowRecents: () => void;
  scheme: ProjectContextTreeScheme | null;
  path: string | null;
  onShowFiles: () => void;
  onShowFolder: (path: string) => void;
  sidebarToggle: PaneHeaderRailToggle;
  dockToggle: PaneHeaderRailToggle;
}) {
  const { tabs } = useContextTabs(projectId);
  const open = useOpenDocumentInEditor();
  const removal = useContextRemovalCoordinator();
  const visibleTabs = editorWorkId ? tabs.filter((tab) => isEditorTab(tab, editorWorkId)) : [];
  const segments: MobileBreadcrumbSegment[] = [{ label: t`Files`, onSelect: onShowFiles }];
  if (scheme) {
    const browsable = scheme !== "scratch";
    segments.push({
      label: schemeLabel(scheme),
      ...(browsable ? { onSelect: () => onShowFolder("") } : {}),
    });
    if (path) {
      const parent = path.slice(0, path.lastIndexOf("/"));
      for (const folder of folderAncestry(parent))
        segments.push({
          label: folder.name,
          ...(browsable ? { onSelect: () => onShowFolder(folder.path) } : {}),
        });
      segments.push({ label: pathLeafName(path) });
    }
  }
  return (
    <>
      <ContextTabBar
        tabs={visibleTabs}
        activeTabId={null}
        onSelect={open}
        onClose={(tab) => {
          const result = removal.writerClose(projectId, tab);
          if (result instanceof Promise)
            void result.then(
              (settlement) => {
                if (settlement.kind === "failed") reportError(settlement.error);
              },
              (error: unknown) => reportError(error),
            );
        }}
        onShowRecents={onShowRecents}
      />
      <PaneHeader
        title={<MobileBreadcrumb segments={segments} />}
        left={sidebarToggle}
        right={dockToggle}
      />
    </>
  );
}
