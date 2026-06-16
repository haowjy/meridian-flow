/**
 * MobileCreateEntryMenu — phone `+` top-bar action for creating a context
 * file or folder where you are (current scheme + folder).
 *
 * This is the phone sibling of the desktop `CreateContextEntryMenu`: same
 * two-option vocabulary (New file / New folder, FilePlus / FolderPlus, the
 * shared `ContextCreateKind`), but phone chrome — a 44px `PhoneIconButton`
 * trigger in the top bar's trailing slot and 44px menu items. A separate
 * component (rather than presentation flags on the desktop menu) keeps the
 * shared component free of phone branches; only the create *kind* contract
 * is shared because the server mutation owns the payload.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { FilePlus, FolderPlus, Plus } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PhoneIconButton } from "@/components/ui/phone-icon-button";

import type { ContextCreateKind } from "../context/context-create-kind";

export type MobileCreateEntryMenuProps = {
  /** Triggered when the user selects "New file" or "New folder". */
  onSelect: (kind: ContextCreateKind) => void;
};

export function MobileCreateEntryMenu({ onSelect }: MobileCreateEntryMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PhoneIconButton aria-label={t`Create file or folder`}>
          <Plus className="size-5" aria-hidden />
        </PhoneIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        // Radix restores focus to the trigger when the menu closes, which
        // would beat the create row's input autofocus — the row would render
        // with focus (and the phone keyboard) stuck on the `+` button.
        // Selecting an item always opens the naming row, so the row owns the
        // next focus.
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="min-w-44 border-border bg-background shadow-md"
      >
        <DropdownMenuItem
          className="min-h-11 cursor-pointer gap-3 px-3 text-sm focus:bg-sidebar-accent"
          onSelect={() => onSelect("file")}
        >
          <FilePlus className="size-4 text-muted-foreground" aria-hidden />
          <Trans>New file</Trans>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="min-h-11 cursor-pointer gap-3 px-3 text-sm focus:bg-sidebar-accent"
          onSelect={() => onSelect("folder")}
        >
          <FolderPlus className="size-4 text-muted-foreground" aria-hidden />
          <Trans>New folder</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
