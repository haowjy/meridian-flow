/** Completion text and the writer's next/exit action, shared by review shells. */

import { Trans } from "@lingui/react/macro";
import { Loader2 } from "lucide-react";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { Button } from "@/components/ui/button";

export type ReviewStateProps = {
  finished: boolean;
  /** A whole-draft command is in flight: nothing is finished yet. */
  completing?: "apply" | "discard" | null;
  next: ReviewFileTarget | null;
  draftOnly: boolean;
  onOpenNext: (row: ReviewFileTarget) => void;
  onShowLive: () => void;
};

export function ReviewStatusContent({
  completing,
  finished,
}: Pick<ReviewStateProps, "completing" | "finished">) {
  if (completing) {
    return (
      <>
        <Loader2 className="size-3 animate-spin" aria-hidden />
        {completing === "apply" ? <Trans>Applying</Trans> : <Trans>Discarding</Trans>}
      </>
    );
  }
  if (finished) return <Trans>No changes left</Trans>;
  return null;
}

/** A whole-file command in flight, said on the file the writer acted on. */
export function FileCommandStatus({ mode }: { mode: "apply" | "discard" }) {
  return (
    <span
      role="status"
      aria-busy
      className="flex shrink-0 items-center gap-1 px-1 text-caption text-ink-muted"
    >
      <ReviewStatusContent completing={mode} finished={false} />
    </span>
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
