/** Confirm Stop here. The primary is the default style: stopping loses nothing already imported. */
import { plural } from "@lingui/core/macro";
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

export function StopImportDialog({
  remaining,
  onKeep,
  onStop,
}: {
  remaining: number;
  onKeep: () => void;
  onStop: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onKeep()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            <Trans>Stop this import?</Trans>
          </DialogTitle>
          <DialogDescription>
            {plural(remaining, {
              one: "# file hasn't arrived.",
              other: "# files haven't arrived.",
            })}{" "}
            <Trans>Files already here stay. Nothing more will be added.</Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" className="[@media(pointer:coarse)]:min-h-11">
              <Trans>Keep importing</Trans>
            </Button>
          </DialogClose>
          <Button className="[@media(pointer:coarse)]:min-h-11" onClick={onStop}>
            <Trans>Stop here</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
