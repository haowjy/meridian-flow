/** The identity bar's status chips: Choose a home and device-only. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { FolderDown, TriangleAlert } from "lucide-react";

import { Chip } from "@/components/ui/chip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const appear = "motion-safe:animate-in motion-safe:fade-in";

/** Choose a home: the invitation a document in Unfiled carries until it has a
 *  home. Jade, because it asks the writer for something. Its label is as short
 *  as a chip on the path can be; the tooltip explains. Once the document is
 *  placed, the chip goes and renaming or moving happens in the lists. */
export function ChooseHomeChip({ onClick }: { onClick: () => void }) {
  return (
    // Hoverable: this sentence is said nowhere else, so a magnified reader
    // must be able to move onto it; nothing sits beside the chip to block.
    <Tooltip hoverable>
      <TooltipTrigger asChild>
        <Chip asChild tone="jade" className={`focus-ring ${appear}`}>
          <button
            type="button"
            // The label hides in a narrow pane (the side); the button keeps its name.
            aria-label={t`File this document`}
            onClick={onClick}
          >
            <FolderDown aria-hidden className="size-3" />
            <span className="@max-md:hidden">
              <Trans>File it</Trans>
            </span>
          </button>
        </Chip>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-60">
        <Trans>
          Not filed yet, so it sits in Unfiled. Click to give it a name and a place in your project.
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
        <Chip role="status" tone="warning" className={appear}>
          <TriangleAlert aria-hidden className="size-3" />
          <span className="@max-md:hidden">{label}</span>
        </Chip>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
