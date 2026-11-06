/**
 * The Import button in a section header. With nothing to report it opens the Folder… / Files…
 * menu. While the area has an import running or waiting on the writer it shows that, stays visible
 * without hover, and opens the popup instead (the sheet on a phone).
 */
import type { ImportScheme } from "@meridian/contracts";
import { ImportIcon, LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
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
  const [menuOpen, setMenuOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // One button in every state, so a status change never drops focus or closes an open menu.
  return (
    <Popover open={open && !phone} onOpenChange={setOpen}>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(next) => {
          if (active && !menuOpen) setOpen(!open);
          else setMenuOpen(next);
        }}
      >
        <PopoverAnchor asChild>
          <DropdownMenuTrigger asChild>
            <PaneHeaderActionButton
              ref={trigger}
              data-import-status={status ?? undefined}
              icon={status === "running" ? LoaderCircle : ImportIcon}
              iconClassName={
                status === "running" ? "animate-spin motion-reduce:animate-none" : undefined
              }
              label={label}
            >
              {status === "needs-writer" ? (
                <span
                  aria-hidden
                  className="absolute top-0 right-0 size-1.5 rounded-full bg-primary"
                />
              ) : null}
            </PaneHeaderActionButton>
          </DropdownMenuTrigger>
        </PopoverAnchor>
        <DropdownMenuContent align="start">
          <ImportMenuItems onPick={onPick} />
        </DropdownMenuContent>
      </DropdownMenu>
      <PopoverContent
        align="start"
        aria-label={label}
        className="flex max-h-[min(28rem,70svh)] w-80 flex-col p-0"
        // The button toggles the popup itself; its press must not also count as outside.
        onInteractOutside={(event) => {
          if (trigger.current?.contains(event.target as Node)) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          trigger.current?.focus();
        }}
      >
        <ImportPanelBody items={items} onPick={onPick} onClose={() => setOpen(false)} />
      </PopoverContent>
      {phone ? (
        <ImportSheet items={items} open={open} onOpenChange={setOpen} onPick={onPick} />
      ) : null}
    </Popover>
  );
}
