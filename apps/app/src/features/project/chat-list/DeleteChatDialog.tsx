/** Confirmation for deleting a chat, in the same shape as deleting a file. */
import { Trans } from "@lingui/react/macro";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type DeleteChatTarget = { id: string; title: string };

/**
 * Confirm-then-optimistic: confirming closes this dialog immediately, so it
 * never itself waits on the server (a failure surfaces on the row instead).
 */
export function DeleteChatDialog({
  target,
  onCancel,
  onConfirm,
}: {
  target: DeleteChatTarget | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            <Trans>Delete chat?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              <strong className="break-all font-semibold text-foreground">{target?.title}</strong>{" "}
              and its messages will be deleted.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <DialogClose asChild>
            <Button variant="outline" size="sm">
              <Trans>Cancel</Trans>
            </Button>
          </DialogClose>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            <Trans>Delete</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
