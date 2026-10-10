/** Assemble the two slot owners only for an explicit rail screen switch. */
import { getContextTabs } from "@/client/stores";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import {
  useAccountResourceProjection,
  useContextRemovalCoordinator,
} from "../context/account-feature-context";
import {
  resolveVisibleEditorTab,
  type VisibleEditorRoute,
} from "../context/resolve-visible-editor-tab";
import type { ScreenKey } from "../shell/screens";
import { handOffVisibleDocument } from "./hand-off-visible-document";

export function useRailDocumentHandOff({
  projectId,
  source,
  editor,
  revealDock,
}: {
  projectId: string;
  source: ScreenKey;
  editor: VisibleEditorRoute;
  revealDock: (view: "document") => void;
}) {
  const phone = usePhoneShell() === true;
  const { records, folders } = useAccountResourceProjection(projectId);
  const removal = useContextRemovalCoordinator();
  return (destination: ScreenKey) => {
    const workspace = getContextTabs(projectId);
    const { tab } = resolveVisibleEditorTab({
      ...editor,
      tabs: workspace.tabs,
      selectedTabId: workspace.selectedTabIdByWork[editor.editorWorkId ?? ""],
      selection: removal.getProjectSnapshot(projectId).selection,
    });
    return handOffVisibleDocument({
      projectId,
      source,
      destination,
      phone,
      editorTab: tab,
      records,
      folders,
      revealDock,
    });
  };
}
