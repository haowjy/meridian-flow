/** The identity bar's status chips: re-home ("Choose a home" / "Rename") and device-only. */
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

/** The permanent re-home affordance (D4), whose label graduates with the
 *  document: jade "Choose a home" while provisional (an invitation), quiet
 *  outline "Rename" once homed (a tool — rename is the common case; folder
 *  browsing in the same field keeps move discoverable). Same geometry in both states. */
export function HomeChip({ provisional, onClick }: { provisional: boolean; onClick: () => void }) {
  return (
    // Hoverable: this sentence is said nowhere else, so a magnified reader
    // must be able to move onto it; nothing sits beside the chip to block.
    <Tooltip hoverable>
      <TooltipTrigger asChild>
        <button
          key={provisional ? "invite" : "quiet"}
          type="button"
          onClick={onClick}
          className={cn(
            "focus-ring",
            chipClass,
            provisional
              ? "border-primary/30 bg-primary/10 text-jade-text"
              : "border-border bg-transparent text-ink-subtle",
          )}
        >
          <FolderDown aria-hidden className="size-3" />
          <span className="@max-md:hidden">
            {provisional ? <Trans>Choose a home</Trans> : <Trans>Rename</Trans>}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-60">
        {provisional ? (
          <Trans>
            This draft is untitled and lives in your Scratch. Click to name it or move it where it
            belongs.
          </Trans>
        ) : (
          <Trans>Rename this document or move it somewhere else in your project.</Trans>
        )}
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
