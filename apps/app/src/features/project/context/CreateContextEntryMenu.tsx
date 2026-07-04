import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { FilePlus, FolderPlus, Plus } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";

import type { ContextCreateKind } from "./context-create-kind";

export type CreateContextEntryMenuProps = {
  /** Triggered when the user selects "New file" or "New folder". */
  onSelect: (kind: ContextCreateKind) => void;
};

/**
 * Compact `+` trigger that opens a two-option menu. Used as the inline header
 * action on the ContextTreePanel. The mobile variant was removed with the
 * desktop-only decision.
 */
export function CreateContextEntryMenu({ onSelect }: CreateContextEntryMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton size="sm" aria-label={t`Create file or folder`}>
          <Plus aria-hidden />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="min-w-44 border-border bg-background shadow-md"
      >
        <DropdownMenuItem
          className="cursor-pointer gap-2 py-2 text-[14px] focus:bg-sidebar-accent"
          onSelect={() => onSelect("file")}
        >
          <FilePlus className="size-4 text-muted-foreground" aria-hidden />
          <Trans>New file</Trans>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="cursor-pointer gap-2 py-2 text-[14px] focus:bg-sidebar-accent"
          onSelect={() => onSelect("folder")}
        >
          <FolderPlus className="size-4 text-muted-foreground" aria-hidden />
          <Trans>New folder</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
