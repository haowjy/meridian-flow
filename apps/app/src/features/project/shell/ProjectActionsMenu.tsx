/** Project commands and the small, opt-in export dialog. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Download } from "lucide-react";
import { useId, useState } from "react";
import { downloadProjectExport } from "@/client/api/project-export-api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { OverflowMenu } from "@/components/ui/overflow-menu";

export function ProjectActionsMenu({ projectId }: { projectId: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [scratch, setScratch] = useState(false);
  const [uploads, setUploads] = useState(false);
  return (
    <>
      <OverflowMenu label={t`Project actions`}>
        <DropdownMenuItem
          onSelect={() => {
            setScratch(false);
            setUploads(false);
            setOpen(true);
          }}
        >
          <Download aria-hidden className="size-3.5" />
          <Trans>Export project…</Trans>
        </DropdownMenuItem>
      </OverflowMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              <Trans>Export project</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>Download a folder of Markdown files as a ZIP.</Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <label htmlFor={`${id}-scratch`} className="flex items-center gap-2 text-sm">
              <Input
                id={`${id}-scratch`}
                type="checkbox"
                className="size-4"
                checked={scratch}
                onChange={(event) => setScratch(event.target.checked)}
              />
              <Trans>Include Scratch</Trans>
            </label>
            <label htmlFor={`${id}-uploads`} className="flex items-center gap-2 text-sm">
              <Input
                id={`${id}-uploads`}
                type="checkbox"
                className="size-4"
                checked={uploads}
                onChange={(event) => setUploads(event.target.checked)}
              />
              <Trans>Include Uploads</Trans>
            </label>
          </div>
          <DialogFooter>
            <Button onClick={() => downloadProjectExport(projectId, { scratch, uploads })}>
              <Trans>Export</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
