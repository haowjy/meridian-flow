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
import { useState } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { useOpenContextRoute, useRunDocumentSwitch } from "../routing/ProjectNavigationContext";
import { openDocumentInEditor } from "../routing/use-open-document-in-editor";
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
  const open = useOpenContextRoute();
  const runSwitch = useRunDocumentSwitch();
  const revision = useDockViewStore((state) => state.revision);
  const [failedClaim, setFailedClaim] = useState<number | null>(null);
  return (
    <div className="flex items-center gap-2">
      {failedClaim === revision && (
        <span role="alert" className="text-xs text-destructive">
          <Trans>This view couldn’t open.</Trans>
        </span>
      )}
      <IconButton
        size="sm"
        tooltip={t`Open in Editor`}
        onClick={() => {
          if (!open || !runSwitch) return;
          setFailedClaim(null);
          const store = useDockViewStore.getState();
          const claim = store.claim();
          void runSwitch(
            (onAccepted) =>
              openDocumentInEditor(
                open,
                tab,
                () => {
                  if (useDockViewStore.getState().isCurrent(claim)) store.closeDocument();
                },
                onAccepted,
              ),
            () => setFailedClaim(claim),
          );
        }}
      >
        <Maximize2 className="size-4" aria-hidden />
      </IconButton>
    </div>
  );
}
