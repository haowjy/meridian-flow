/**
 * DockDocumentCommands — the buttons at the left of an open dock document's
 * header: Close document and Open in Editor; a view that could not open says
 * so in a line under the header, which Open in Editor is described by.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Maximize2, X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { useDockEditorJump } from "../DesktopProjectController";
import { headerFailure, useDocumentSwitchFailures } from "../routing/document-switch-failure";
import { type DockDocument, useDockDocumentStore } from "./dock-document-store";

/** True while this dock revision's Open in Editor failed. */
export function useDockViewFailed(): boolean {
  const { failures } = useDocumentSwitchFailures();
  const revision = useDockDocumentStore((state) => state.revision);
  return headerFailure(failures, revision);
}

export const DOCK_VIEW_FAILURE_ID = "dock-view-failure";

/** The failure line under the header row; Open in Editor points at it. */
export function DockViewFailureNote() {
  return (
    <p id={DOCK_VIEW_FAILURE_ID} role="alert" className="px-3 pb-1 text-destructive text-xs">
      <Trans>This view couldn’t open.</Trans>
    </p>
  );
}

export function DockDocumentCommands({
  document,
  failed,
}: {
  document: DockDocument;
  failed: boolean;
}) {
  const open = useDockEditorJump();
  const closeDocument = useDockDocumentStore((state) => state.closeDocument);
  const coarse = "[@media(pointer:coarse)]:size-11";
  return (
    <>
      <IconButton size="sm" tooltip={t`Close document`} className={coarse} onClick={closeDocument}>
        <X aria-hidden className="size-4" />
      </IconButton>
      <IconButton
        size="sm"
        tooltip={t`Open in Editor`}
        aria-describedby={failed ? DOCK_VIEW_FAILURE_ID : undefined}
        className={cn(coarse, failed && "text-destructive")}
        onClick={() => open?.(document.tab)}
      >
        <Maximize2 aria-hidden className="size-4" />
      </IconButton>
    </>
  );
}
