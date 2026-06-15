/**
 * RestoreOriginalDialog — confirm restoring the pristine package revision.
 */
import { Trans } from "@lingui/react/macro";

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
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="focus-ring rounded-md border border-border-subtle px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-subtle"
          >
            <Trans>Cancel</Trans>
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="focus-ring rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {pending ? <Trans>Restoring…</Trans> : <Trans>Restore original</Trans>}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
