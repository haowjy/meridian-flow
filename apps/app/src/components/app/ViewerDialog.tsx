import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

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
      <DialogContent className="flex h-[min(48rem,calc(100dvh-2rem))] max-w-[min(56rem,calc(100vw-2rem))] flex-col gap-0 overflow-hidden rounded-lg p-0">
        <DialogTitle className="flex items-center gap-2 border-b border-border-subtle py-3 pr-12 pl-4 text-sm font-medium">
          <span className="min-w-0 truncate">{title}</span>
          {titleExtra}
        </DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}
