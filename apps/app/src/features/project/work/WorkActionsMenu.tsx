/** The one Work `…` menu, shared by the Work page header and Work list rows. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { isWorkArchived, type Work } from "@meridian/contracts/works";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { nameWithHandle } from "@/lib/work-name";

export function WorkActionsMenu({
  work,
  handle,
  onToggleArchive,
  onDelete,
  triggerClassName,
}: {
  work: Work;
  /** Its handle, where another Work shares its name (`WorkHandleOf`). */
  handle?: string | null;
  onToggleArchive: () => void;
  onDelete: () => void;
  triggerClassName?: string;
}) {
  const archived = isWorkArchived(work);
  return (
    <OverflowMenu
      label={t`Actions for ${nameWithHandle(work.name, handle)}`}
      triggerClassName={triggerClassName}
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
