/** The one Work `…` menu, shared by the Work page header and Work list rows. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { OverflowMenu } from "@/components/ui/overflow-menu";

export function WorkActionsMenu({
  work,
  onToggleArchive,
  onDelete,
  triggerClassName,
}: {
  work: Work;
  onToggleArchive: () => void;
  onDelete: () => void;
  triggerClassName?: string;
}) {
  const archived = work.archivedAt !== null;
  return (
    <OverflowMenu
      label={t`Actions for ${work.name}`}
      triggerClassName={triggerClassName ?? "[@media(pointer:coarse)]:size-11"}
    >
      <DropdownMenuItem onSelect={onToggleArchive}>
        {archived ? (
          <ArchiveRestore className="size-3.5 text-muted-foreground" aria-hidden />
        ) : (
          <Archive className="size-3.5 text-muted-foreground" aria-hidden />
        )}
        {archived ? <Trans>Unarchive</Trans> : <Trans>Archive</Trans>}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onSelect={onDelete}>
        <Trash2 className="size-3.5" aria-hidden />
        <Trans>Delete Work</Trans>
      </DropdownMenuItem>
    </OverflowMenu>
  );
}
