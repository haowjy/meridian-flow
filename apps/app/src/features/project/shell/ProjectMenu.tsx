/** Project-title menu shared by the desktop rail and phone drawer. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Download, MoreHorizontal } from "lucide-react";
import { useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { ExportProjectDialog } from "@/features/export/ExportProjectDialog";
import { useAccountEpochSignal } from "../context/account-feature-context";
export function ProjectMenu({
  projectId,
  project,
  onRename,
}: {
  projectId: string;
  project: string;
  onRename(): void;
}) {
  const accountSignal = useAccountEpochSignal();
  const [exporting, setExporting] = useState(false);
  const selecting = useRef(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton size="xs" tooltip={t`Project actions`}>
            <MoreHorizontal aria-hidden />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (selecting.current) {
              event.preventDefault();
              selecting.current = false;
            }
          }}
        >
          <DropdownMenuItem
            onSelect={() => {
              selecting.current = true;
              onRename();
            }}
          >
            <Trans>Rename project</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              selecting.current = true;
              setExporting(true);
            }}
          >
            <Download aria-hidden className="size-3.5" />
            <Trans>Export project…</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {exporting ? (
        <ExportProjectDialog
          key={projectId}
          accountSignal={accountSignal}
          projectId={projectId}
          project={project}
          onClose={() => setExporting(false)}
        />
      ) : null}
    </>
  );
}
