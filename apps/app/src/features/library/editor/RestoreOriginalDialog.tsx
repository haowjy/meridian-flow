/**
 * RestoreOriginalDialog — confirm restoring the pristine package revision.
 */
import { Trans } from "@lingui/react/macro";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function RestoreOriginalDialog({
  open,
  pending,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Restore original?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              This brings back the installed package version. Your edit history is kept as earlier
              revisions.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-end">
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={pending}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="button" size="sm" onClick={onConfirm} disabled={pending}>
            {pending ? <Trans>Restoring…</Trans> : <Trans>Restore original</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
