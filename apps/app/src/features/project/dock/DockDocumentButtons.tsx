/**
 * The dock document header's two buttons: Close, left of the title chip, and
 * Open in Editor, on the right just before the dock's collapse toggle. Open in
 * Editor is the deliberate jump: it closes the dock document and opens the
 * document as an Editor tab, from the tab as the resource projection now shows
 * it (so a rename elsewhere is followed).
 */
import { t } from "@lingui/core/macro";
import { Maximize2, X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { useOpenDocumentInEditor } from "../routing/use-open-document-in-editor";
import { type DockDocument, useDockViewStore } from "./dock-view-store";
import { useDockDocumentTab } from "./use-dock-document-tab";

export function DockDocumentClose() {
  const closeDocument = useDockViewStore((state) => state.closeDocument);
  return (
    <IconButton size="sm" tooltip={t`Close document`} onClick={closeDocument}>
      <X className="size-4" aria-hidden />
    </IconButton>
  );
}

export function DockOpenInEditor({
  projectId,
  document,
}: {
  projectId: string;
  document: DockDocument;
}) {
  const { tab } = useDockDocumentTab(projectId, document);
  const closeDocument = useDockViewStore((state) => state.closeDocument);
  const openInEditor = useOpenDocumentInEditor();
  return (
    <IconButton
      size="sm"
      tooltip={t`Open in Editor`}
      onClick={() => {
        closeDocument();
        openInEditor(tab);
      }}
    >
      <Maximize2 className="size-4" aria-hidden />
    </IconButton>
  );
}
