/**
 * UnsavedChangesDialog — blocks list selection changes while a draft is dirty.
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
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={saving}>
            <Trans>Keep editing</Trans>
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onDiscard} disabled={saving}>
            <Trans>Discard</Trans>
          </Button>
          <Button type="button" size="sm" onClick={onSaveAndSwitch} disabled={saving}>
            {saving ? <Trans>Saving…</Trans> : <Trans>Save and switch</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
