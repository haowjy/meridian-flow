/** Project-title menu shared by the desktop rail and phone drawer. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, MoreHorizontal, Pencil, Settings, Upload } from "lucide-react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useMenuActionDispatch,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { useSettingsNavigation } from "@/features/account/SettingsDialog";
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
  const settings = useSettingsNavigation();
  const [exporting, setExporting] = useState(false);
  const { dispatch, onCloseAutoFocus } = useMenuActionDispatch();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton size="xs" label={t`Project actions`}>
            <MoreHorizontal aria-hidden />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={onCloseAutoFocus}>
          <DropdownMenuItem onSelect={() => dispatch(onRename)}>
            <Pencil aria-hidden className="size-3.5" />
            <Trans>Rename project</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => dispatch(() => setExporting(true))}>
            <Upload aria-hidden className="size-3.5" />
            <Trans>Export project…</Trans>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => dispatch(() => settings.open())} note="Ctrl ,">
            <Settings aria-hidden className="size-3.5" />
            <Trans>Settings</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/">
              <ArrowLeft aria-hidden className="size-3.5" />
              <Trans>All projects</Trans>
            </Link>
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
