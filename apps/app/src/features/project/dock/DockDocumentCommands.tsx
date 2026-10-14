/**
 * DockDocumentCommands — the buttons at the left of an open dock document's
 * header: Close document and Open in Editor, and where a view that could not
 * open says so.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Maximize2, X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { useDockEditorJump } from "../DesktopProjectController";
import { headerFailure, useDocumentSwitchFailures } from "../routing/document-switch-failure";
import { type DockDocument, useDockDocumentStore } from "./dock-document-store";

export function DockDocumentCommands({ document }: { document: DockDocument }) {
  const open = useDockEditorJump();
  const closeDocument = useDockDocumentStore((state) => state.closeDocument);
  const { failures } = useDocumentSwitchFailures();
  const revision = useDockDocumentStore((state) => state.revision);
  const failed = headerFailure(failures, revision);
  const coarse = "[@media(pointer:coarse)]:size-11";
  return (
    <>
      {failed && (
        <span role="alert" className="sr-only">
          <Trans>This view couldn’t open.</Trans>
        </span>
      )}
      <IconButton size="sm" tooltip={t`Close document`} className={coarse} onClick={closeDocument}>
        <X aria-hidden className="size-4" />
      </IconButton>
      <IconButton
        size="sm"
        tooltip={failed ? t`This view couldn’t open.` : t`Open in Editor`}
        aria-label={t`Open in Editor`}
        className={cn(coarse, failed && "text-destructive")}
        onClick={() => open?.(document.tab)}
      >
        <Maximize2 aria-hidden className="size-4" />
      </IconButton>
    </>
  );
}
