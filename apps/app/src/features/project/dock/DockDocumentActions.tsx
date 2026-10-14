/** Dock document management shares one menu, leaving the identity row its width. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Maximize2, MoreHorizontal, PanelRightClose, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { useDockEditorJump } from "../DesktopProjectController";
import { headerFailure, useDocumentSwitchFailures } from "../routing/document-switch-failure";
import { type DockDocument, useDockDocumentStore } from "./dock-document-store";

export function DockDocumentActions({
  document,
  onCollapse,
}: {
  document: DockDocument;
  onCollapse?: () => void;
}) {
  const open = useDockEditorJump();
  const closeDocument = useDockDocumentStore((state) => state.closeDocument);
  const { failures } = useDocumentSwitchFailures();
  const revision = useDockDocumentStore((state) => state.revision);
  const failed = headerFailure(failures, revision);
  return (
    <>
      {failed && (
        <span role="alert" className="sr-only">
          <Trans>This view couldn’t open.</Trans>
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            size="sm"
            tooltip={failed ? t`This view couldn’t open.` : t`Document actions`}
            className={cn("[@media(pointer:coarse)]:size-11", failed && "text-destructive")}
          >
            <MoreHorizontal aria-hidden className="size-4" />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {failed ? (
            <p className="px-2 py-1 text-xs text-destructive">
              <Trans>This view couldn’t open.</Trans>
            </p>
          ) : null}
          <DropdownMenuItem onSelect={() => open?.(document.tab)}>
            <Maximize2 aria-hidden />
            <Trans>Open in Editor</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={closeDocument}>
            <X aria-hidden />
            <Trans>Close document</Trans>
          </DropdownMenuItem>
          {onCollapse ? (
            <DropdownMenuItem onSelect={onCollapse}>
              <PanelRightClose aria-hidden />
              <Trans>Collapse dock</Trans>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
