/** Quick project-title edit shared by desktop and phone workspace chrome. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export function RenameProjectDialog({
  title,
  pending,
  error,
  onClose,
  onSave,
}: {
  title: string;
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onSave: (title: string) => void;
}) {
  const [value, setValue] = useState(title);
  const trimmed = value.trim();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed && !pending) onSave(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Rename project</Trans>
            </DialogTitle>
          </DialogHeader>
          <label htmlFor="project-title" className="mt-4 grid gap-1.5 text-sm font-medium">
            <Trans>Project title</Trans>
            <Input
              id="project-title"
              autoFocus
              value={value}
              disabled={pending}
              onChange={(event) => setValue(event.target.value)}
              aria-describedby={error ? "project-title-error" : undefined}
            />
          </label>
          {error ? (
            <p id="project-title-error" role="alert" className="mt-3 text-sm text-destructive">
              {t`Project title could not be saved. Try again.`}
            </p>
          ) : null}
          <DialogFooter className="mt-5">
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              className="[@media(pointer:coarse)]:min-h-11"
              onClick={onClose}
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button
              type="submit"
              disabled={pending || !trimmed}
              aria-busy={pending}
              className="[@media(pointer:coarse)]:min-h-11"
            >
              {pending ? <Trans>Saving…</Trans> : <Trans>Save changes</Trans>}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
