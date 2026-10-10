/** Assemble the two slot owners only for an explicit rail screen switch. */
import type { FolderNamespaceRecord, ResourceRecord } from "@meridian/resource-replica";
import { getContextTabs } from "@/client/stores";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import {
  useAccountResourceProjection,
  useContextRemovalCoordinator,
} from "../context/account-feature-context";
import type { ContextRouteSelection } from "../context/context-removal-protocol";
import {
  resolveVisibleEditorTab,
  type VisibleEditorRoute,
} from "../context/resolve-visible-editor-tab";
import type { ScreenKey } from "../shell/screens";
import { handOffVisibleDocument } from "./hand-off-visible-document";

export function useRailDocumentHandOff({
  projectId,
  source,
  revealDock,
}: {
  projectId: string;
  source: ScreenKey;
  revealDock: (view: "document") => void;
}) {
  const phone = usePhoneShell() === true;
  const { records, folders } = useAccountResourceProjection(projectId);
  const removal = useContextRemovalCoordinator();
  return (destination: ScreenKey, editor: VisibleEditorRoute | null) =>
    captureRailDocumentHandOff({
      projectId,
      source,
      destination,
      editor,
      phone,
      records,
      folders,
      selection: removal.getProjectSnapshot(projectId).selection,
      revealDock,
    });
}

export function captureRailDocumentHandOff({
  projectId,
  editor,
  selection,
  ...input
}: {
  projectId: string;
  editor: VisibleEditorRoute | null;
  selection: ContextRouteSelection;
  source: ScreenKey;
  destination: ScreenKey;
  phone: boolean;
  records: readonly ResourceRecord[];
  folders: readonly FolderNamespaceRecord[];
  revealDock: (view: "document") => void;
}) {
  const workspace = getContextTabs(projectId);
  const tab = editor
    ? resolveVisibleEditorTab({
        ...editor,
        tabs: workspace.tabs,
        selectedTabId: workspace.selectedTabIdByWork[editor.editorWorkId ?? ""],
        selection,
      }).tab
    : null;
  return handOffVisibleDocument({ ...input, projectId, editorTab: tab });
}
