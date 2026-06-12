// @ts-nocheck
/**
 * UnsavedChangesDialog — blocks list selection changes while a draft is dirty.
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

export function UnsavedChangesDialog({
  open,
  saving,
  onDiscard,
  onSaveAndSwitch,
  onCancel,
}: {
  open: boolean;
  saving: boolean;
  onDiscard: () => void;
  onSaveAndSwitch: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Save changes?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>You have unsaved edits. Save before switching, or discard them.</Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="focus-ring rounded-md border border-border-subtle px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-subtle"
          >
            <Trans>Keep editing</Trans>
          </button>
          <button
            type="button"
            onClick={onDiscard}
            disabled={saving}
            className="focus-ring rounded-md border border-border-subtle px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-subtle"
          >
            <Trans>Discard</Trans>
          </button>
          <button
            type="button"
            onClick={onSaveAndSwitch}
            disabled={saving}
            className="focus-ring rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saving ? <Trans>Saving…</Trans> : <Trans>Save and switch</Trans>}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
