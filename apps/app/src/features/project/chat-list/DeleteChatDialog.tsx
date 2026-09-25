/** Confirmation for deleting a chat, in the same shape as deleting a file. */
import { Trans } from "@lingui/react/macro";
import type { DeleteChatTarget } from "@/client/query/useDeleteChat";
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

export function DeleteChatDialog({
  target,
  isPending,
  error,
  onCancel,
  onConfirm,
}: {
  target: DeleteChatTarget | null;
  isPending: boolean;
  error: Error | null;
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
        {error ? (
          <p className="text-sm text-destructive">
            <Trans>Couldn't delete this chat. Try again.</Trans>
          </p>
        ) : null}
        <DialogFooter className="gap-2 sm:gap-0">
          <DialogClose asChild>
            <Button variant="outline" size="sm" disabled={isPending}>
              <Trans>Cancel</Trans>
            </Button>
          </DialogClose>
          <Button variant="destructive" size="sm" disabled={isPending} onClick={onConfirm}>
            {isPending ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
