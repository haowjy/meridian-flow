/** Completion text and the writer's next/exit action, shared by review shells. */

import { Trans } from "@lingui/react/macro";
import { Loader2 } from "lucide-react";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { Button } from "@/components/ui/button";

export type ReviewStateProps = {
  finished: boolean;
  /** The draft is open and lists no change: what remains is handled by Apply draft or Discard draft. */
  unlisted?: boolean;
  /** The last change's command is in flight: nothing is finished yet. */
  completing?: "apply" | "discard" | null;
  next: ReviewFileTarget | null;
  draftOnly: boolean;
  onOpenNext: (row: ReviewFileTarget) => void;
  onShowLive: () => void;
};

export function ReviewStatusContent({
  completing,
  finished,
  explainFormatting = false,
}: Pick<ReviewStateProps, "completing" | "finished"> & { explainFormatting?: boolean }) {
  if (completing) {
    return (
      <>
        <Loader2 className="size-3 animate-spin" aria-hidden />
        {completing === "apply" ? <Trans>Applying</Trans> : <Trans>Discarding</Trans>}
      </>
    );
  }
  if (finished) return <Trans>No changes left</Trans>;
  return explainFormatting ? (
    <Trans>Formatting changes remain. Apply draft or Discard draft finishes them.</Trans>
  ) : (
    <Trans>Formatting changes remain</Trans>
  );
}

export function ReviewNextAction({
  next,
  draftOnly = false,
  onOpenNext,
  onShowLive,
  size = "xs",
  className,
}: Pick<ReviewStateProps, "next" | "onOpenNext" | "onShowLive"> & {
  draftOnly?: boolean;
  size?: "xs" | "default";
  className?: string;
}) {
  return (
    <Button
      size={size}
      variant={next ? "default" : "outline"}
      className={className}
      onClick={() => (next ? onOpenNext(next) : onShowLive())}
    >
      {next ? (
        <Trans>Next draft</Trans>
      ) : draftOnly ? (
        <Trans>Close review</Trans>
      ) : (
        <Trans>Back to live</Trans>
      )}
    </Button>
  );
}
