/** The identity bar's status chips: Choose a home and device-only. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { FolderDown, TriangleAlert } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { IDENTITY_BAR_BOX_CLASS } from "./identity-bar-geometry";

const chipClass = cn(
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 font-medium font-sans text-xs motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150",
  IDENTITY_BAR_BOX_CLASS,
);

/** The invitation an untitled draft carries until it has a home. Jade, because
 *  it asks the writer for something; once the draft is placed, the chip goes
 *  and renaming or moving happens in the lists that show the document. */
export function ChooseHomeChip({ onClick }: { onClick: () => void }) {
  return (
    // Hoverable: this sentence is said nowhere else, so a magnified reader
    // must be able to move onto it; nothing sits beside the chip to block.
    <Tooltip hoverable>
      <TooltipTrigger asChild>
        <button
          type="button"
          // The label hides in a narrow pane (the dock); the button keeps its name.
          aria-label={t`Choose a home`}
          onClick={onClick}
          className={cn("focus-ring", chipClass, "border-primary/30 bg-primary/10 text-jade-text")}
        >
          <FolderDown aria-hidden className="size-3" />
          <span className="@max-md:hidden">
            <Trans>Choose a home</Trans>
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-60">
        <Trans>
          This draft is untitled and lives in your Scratch. Click to name it or move it where it
          belongs.
        </Trans>
      </TooltipContent>
    </Tooltip>
  );
}

export function DeviceOnlyChip() {
  const label = t`Only on this device`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          className={cn(chipClass, "border-warning-border bg-warning-bg text-warning-foreground")}
        >
          <TriangleAlert aria-hidden className="size-3" />
          <span className="@max-md:hidden">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
