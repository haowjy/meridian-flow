import type { ImportScheme } from "@meridian/contracts";
import { ImportIcon, LoaderCircle } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ImportPanelBody, ImportSheet, importLabel } from "@/features/import/ImportPanel";
import { type PickKind, useImportPanel } from "@/features/import/ImportProvider";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { cn } from "@/lib/utils";

export function ImportHeaderAction({
  scheme,
  onPick,
}: {
  scheme: ImportScheme;
  onPick: (kind: PickKind) => void;
}) {
  const { items, status, open, setOpen } = useImportPanel(scheme);
  const phone = usePhoneShell();
  const label = importLabel(status);
  const pick = (kind: PickKind) => {
    if (items.length === 0) setOpen(false);
    onPick(kind);
  };
  const button = (
    <IconButton
      label={label}
      onClick={phone ? () => setOpen(true) : undefined}
      className="relative"
    >
      {status === "running" ? (
        <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" />
      ) : (
        <ImportIcon aria-hidden />
      )}
      {status === "needs-writer" ? (
        <span aria-hidden className="absolute top-0 right-0 size-1.5 rounded-full bg-primary" />
      ) : null}
    </IconButton>
  );
  if (phone)
    return (
      <>
        {button}
        <ImportSheet items={items} open={open} onOpenChange={setOpen} onPick={pick} />
      </>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{button}</PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={label}
        className={cn(
          "flex max-h-[min(28rem,70svh)] flex-col p-0",
          items.length > 0 ? "w-80" : "w-60",
        )}
      >
        <ImportPanelBody items={items} onPick={pick} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
