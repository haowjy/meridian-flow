/**
 * The dock document header's two buttons: Close, left of the title chip, and
 * Open in Editor, on the right just before the dock's collapse toggle. Open in
 * Editor is the deliberate jump: it closes the dock document and opens the
 * document as an Editor tab, from the tab as the resource projection now shows
 * it (so a rename elsewhere is followed).
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Maximize2, X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { useDockEditorJump } from "../DesktopProjectController";
import { headerFailure, useDocumentSwitchFailures } from "../routing/document-switch-failure";
import { type DockDocument, useDockViewStore } from "./dock-view-store";

export function DockDocumentClose() {
  const closeDocument = useDockViewStore((state) => state.closeDocument);
  return (
    <IconButton size="sm" tooltip={t`Close document`} onClick={closeDocument}>
      <X className="size-4" aria-hidden />
    </IconButton>
  );
}

export function DockOpenInEditor({ document }: { projectId: string; document: DockDocument }) {
  const tab = document.tab;
  const open = useDockEditorJump();
  const { failures } = useDocumentSwitchFailures();
  const revision = useDockViewStore((state) => state.revision);
  return (
    <div className="flex items-center gap-2">
      {headerFailure(failures, revision) && (
        <span role="alert" className="text-xs text-destructive">
          <Trans>This view couldn’t open.</Trans>
        </span>
      )}
      <IconButton size="sm" tooltip={t`Open in Editor`} onClick={() => open?.(tab)}>
        <Maximize2 className="size-4" aria-hidden />
      </IconButton>
    </div>
  );
}
