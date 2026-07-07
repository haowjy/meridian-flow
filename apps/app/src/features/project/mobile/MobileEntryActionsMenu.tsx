/**
 * MobileEntryActionsMenu — phone `...` trailing button for file/folder rows
 * in MobileContextBrowser. Opens a dropdown with Rename and Delete actions.
 *
 * Phone chrome: 44px touch-target button, 44px menu items, same visual
 * language as MobileCreateEntryMenu.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Ellipsis, Pencil, Trash2 } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import type { EntryAction } from "../context/ContextEntryActions";

export function MobileEntryActionsMenu({ onAction }: { onAction: (action: EntryAction) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t`Actions`}
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-sidebar-accent"
        >
          <Ellipsis aria-hidden className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="min-w-44 border-border bg-background shadow-md"
      >
        <DropdownMenuItem
          className="min-h-11 cursor-pointer gap-3 px-3 text-sm focus:bg-sidebar-accent"
          onSelect={() => onAction("rename")}
        >
          <Pencil className="size-4 text-muted-foreground" aria-hidden />
          <Trans>Rename</Trans>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="min-h-11 cursor-pointer gap-3 px-3 text-sm text-destructive focus:bg-sidebar-accent focus:text-destructive"
          onSelect={() => onAction("delete")}
        >
          <Trash2 className="size-4" aria-hidden />
          <Trans>Delete</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
