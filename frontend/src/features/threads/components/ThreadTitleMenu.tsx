import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";

interface ThreadTitleMenuProps {
  trigger: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onRename?: () => void;
  onDelete?: () => void;
  align?: "start" | "end";
  // Future: onExport?, onSettings?
}

/**
 * Reusable dropdown menu for thread actions (rename, delete).
 *
 * Single Responsibility: Renders the dropdown menu with action items.
 * Callbacks are provided by parent - this component doesn't know about stores.
 *
 * Used by: ThreadRow (sidebar), ThreadHeader (center panel)
 */
export function ThreadTitleMenu({
  trigger,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  onRename,
  onDelete,
  align = "end",
}: ThreadTitleMenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);

  // Use controlled state if provided, otherwise use internal state
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = controlledOnOpenChange || setInternalOpen;

  // Close menu and execute action SYNCHRONOUSLY.
  // The click guard in ThreadRow prevents ghost clicks from causing navigation.
  // Action must run before ghost click fires so the guard is set in time.
  const handleAction = (action?: () => void) => () => {
    setOpen(false);
    action?.();
  };

  // Don't render if no actions provided
  if (!onRename && !onDelete) {
    return null;
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        {onRename && (
          <DropdownMenuItem onClick={handleAction(onRename)}>
            <Pencil className="size-3.5" />
            Rename
          </DropdownMenuItem>
        )}
        {onRename && onDelete && <DropdownMenuSeparator />}
        {onDelete && (
          <DropdownMenuItem
            variant="destructive"
            onClick={handleAction(onDelete)}
          >
            <Trash2 className="size-3.5" />
            Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
