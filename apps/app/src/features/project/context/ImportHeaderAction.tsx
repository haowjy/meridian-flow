/**
 * The Import button in a section header. With nothing to report it opens the Folder… / Files…
 * menu. While the area has an import running or waiting on the writer it shows that, stays visible
 * without hover, and opens the popup instead (the sheet on a phone).
 */
import type { ImportScheme } from "@meridian/contracts";
import { ImportIcon, LoaderCircle } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ImportMenuItems } from "@/features/import/ImportMenuItems";
import { ImportPanelBody, ImportSheet, importLabel } from "@/features/import/ImportPanel";
import { type PickKind, useImportPanel } from "@/features/import/ImportProvider";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { PaneHeaderActionButton } from "./RailPaneHeader";

export function ImportHeaderAction({
  scheme,
  onPick,
}: {
  scheme: ImportScheme;
  onPick: (kind: PickKind) => void;
}) {
  const { items, status, open, setOpen, active } = useImportPanel(scheme);
  const phone = usePhoneShell();
  const label = importLabel(status);
  if (!active)
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <PaneHeaderActionButton icon={ImportIcon} label={label} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <ImportMenuItems onPick={onPick} />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  const button = (
    <PaneHeaderActionButton
      data-import-status={status ?? undefined}
      icon={status === "running" ? LoaderCircle : ImportIcon}
      iconClassName={status === "running" ? "animate-spin motion-reduce:animate-none" : undefined}
      label={label}
      onClick={phone ? () => setOpen(true) : undefined}
    >
      {status === "needs-writer" ? (
        <span aria-hidden className="absolute top-0 right-0 size-1.5 rounded-full bg-primary" />
      ) : null}
    </PaneHeaderActionButton>
  );
  if (phone)
    return (
      <>
        {button}
        <ImportSheet items={items} open={open} onOpenChange={setOpen} onPick={onPick} />
      </>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{button}</PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={label}
        className="flex max-h-[min(28rem,70svh)] w-80 flex-col p-0"
      >
        <ImportPanelBody items={items} onPick={onPick} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
