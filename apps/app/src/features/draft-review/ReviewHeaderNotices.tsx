/**
 * ReviewHeaderNotices — the lines a review header can grow under its row: why
 * the last whole-draft command was refused, and, once the writer has handled
 * the last change, "No changes left" with the way on (the next draft, or back
 * to live). The review does not jump on its own, so the finished text can be
 * read. Shared by the desktop and phone headers; `touch` raises the buttons to
 * a phone's 44px.
 */
import { Trans } from "@lingui/react/macro";
import { Loader2 } from "lucide-react";
import type { DraftCommandFailureCode } from "@/client/query/draft-command-record";
import { Button } from "@/components/ui/button";
import type { DockRow } from "@/features/chat/docked-drafts";
import { ReviewMessageText } from "@/features/chat/ReviewMessageText";
import { cn } from "@/lib/utils";

export function ReviewHeaderNotices({
  commandError,
  finished,
  completing = null,
  next,
  draftOnly,
  onOpenNext,
  onShowLive,
  touch = false,
}: {
  commandError: DraftCommandFailureCode | null;
  finished: boolean;
  /** The last change's command is in flight: nothing is finished yet. */
  completing?: "apply" | "discard" | null;
  next: DockRow | null;
  draftOnly: boolean;
  onOpenNext: (row: DockRow) => void;
  onShowLive: () => void;
  touch?: boolean;
}) {
  const button = touch ? "h-11 px-4 text-sm" : undefined;
  return (
    <>
      {commandError ? (
        <p className="px-4 pb-1.5 text-destructive" role="alert">
          <ReviewMessageText code={commandError} />
        </p>
      ) : null}
      {completing ? (
        <div
          className={cn(
            "flex items-center gap-2 border-border border-t px-4 text-muted-foreground",
            touch ? "py-2.5" : "py-1.5",
          )}
          role="status"
          aria-busy
        >
          <Loader2 className="size-3 animate-spin" aria-hidden />
          <p>{completing === "apply" ? <Trans>Applying</Trans> : <Trans>Discarding</Trans>}</p>
        </div>
      ) : null}
      {finished ? (
        <div
          className={cn(
            "flex items-center gap-3 border-border border-t px-4",
            touch ? "py-1" : "py-1.5",
          )}
          role="status"
        >
          <p className="flex-1 text-muted-foreground">
            <Trans>No changes left</Trans>
          </p>
          {next ? (
            <Button size="xs" className={button} onClick={() => onOpenNext(next)}>
              <Trans>Next draft</Trans>
            </Button>
          ) : (
            <Button size="xs" variant="outline" className={button} onClick={onShowLive}>
              {draftOnly ? <Trans>Close review</Trans> : <Trans>Back to live</Trans>}
            </Button>
          )}
        </div>
      ) : null}
    </>
  );
}
