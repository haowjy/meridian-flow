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
import { FilePlus, FolderPlus, ImportIcon, LoaderCircle, Plus } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PhoneIconButton } from "@/components/ui/phone-icon-button";
import { ImportMenuItems } from "@/features/import/ImportMenuItems";
import type { PickKind } from "@/features/import/ImportProvider";
import type { ImportStatus } from "@/features/import/import-presentation";

import type { ContextCreateKind } from "../context/context-create-kind";

export type MobileCreateEntryMenuProps = {
  /** Triggered when the user selects "New file" or "New folder". */
  onSelect: (kind: ContextCreateKind) => void;
  /** Present where the area takes imports: opens the OS picker for an import into this folder. */
  onImport?: (kind: PickKind) => void;
  /** What the imports in this project ask of the menu's trigger. */
  importStatus?: ImportStatus | null;
  /** Present while the project has imports to show: Import… opens them instead of the pickers. */
  onOpenImports?: () => void;
};

function triggerLabel(status: ImportStatus | null | undefined): string {
  if (status === "running") return t`Create file or folder, import in progress`;
  if (status === "needs-writer") return t`Create file or folder, import needs your attention`;
  return t`Create file or folder`;
}

export function MobileCreateEntryMenu({
  onSelect,
  onImport,
  importStatus,
  onOpenImports,
}: MobileCreateEntryMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PhoneIconButton aria-label={triggerLabel(importStatus)} className="relative">
          <Plus className="size-5" aria-hidden />
          {importStatus === "running" ? (
            <LoaderCircle
              aria-hidden
              className="absolute top-1.5 right-1.5 size-3 animate-spin rounded-full bg-background text-muted-foreground motion-reduce:animate-none"
            />
          ) : importStatus === "needs-writer" ? (
            <span aria-hidden className="absolute top-2 right-2 size-2 rounded-full bg-primary" />
          ) : null}
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
        <DropdownMenuItem className="cursor-pointer" onSelect={() => onSelect("file")}>
          <FilePlus className="size-4 text-muted-foreground" aria-hidden />
          <Trans>New file</Trans>
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer" onSelect={() => onSelect("folder")}>
          <FolderPlus className="size-4 text-muted-foreground" aria-hidden />
          <Trans>New folder</Trans>
        </DropdownMenuItem>
        {onOpenImports ? (
          <DropdownMenuItem className="cursor-pointer" onSelect={onOpenImports}>
            <ImportIcon className="size-4 text-muted-foreground" aria-hidden />
            <Trans>Import…</Trans>
          </DropdownMenuItem>
        ) : onImport ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="cursor-pointer">
              <ImportIcon className="size-4 text-muted-foreground" aria-hidden />
              <Trans>Import…</Trans>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <ImportMenuItems onPick={onImport} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
