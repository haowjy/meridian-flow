import { t } from "@lingui/core/macro";
import { XIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";

/** The dialog a file opens in when it has no main address: a titled frame around its viewer. */
export function ViewerDialog({
  open,
  onClose,
  title,
  titleExtra,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  titleExtra?: ReactNode;
  description: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        // A viewer opened from a list row is portaled, but React still carries its clicks and keys
        // up to the row, which would open or move in the list behind it.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        showCloseButton={false}
        className="flex h-[min(48rem,calc(100dvh-2rem))] max-w-[min(56rem,calc(100vw-2rem))] flex-col gap-0 overflow-hidden rounded-lg p-0"
      >
        <div className="flex items-center gap-2 border-b border-border-subtle py-1.5 pr-3 pl-4">
          <DialogTitle className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
            <span className="min-w-0 truncate">{title}</span>
            {titleExtra}
          </DialogTitle>
          <DialogClose asChild>
            <IconButton size="sm" label={t`Close`}>
              <XIcon aria-hidden />
            </IconButton>
          </DialogClose>
        </div>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}
