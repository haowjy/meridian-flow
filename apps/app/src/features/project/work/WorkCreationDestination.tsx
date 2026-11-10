/** Pending and failed UI for a Work still being created. */
import { Trans } from "@lingui/react/macro";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { PlainWorkHeading } from "./WorkTitles";

/** A Work still being created: its title, its state, and Retry or Discard on failure. */
export function WorkCreationDestination({
  name,
  goal,
  failed,
  onRetry,
  onDiscard,
}: {
  name: string;
  goal: string | null;
  failed: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  return (
    <article className="flex min-w-0 flex-col gap-3">
      <PlainWorkHeading name={name} />
      <p
        className={`flex items-center gap-2 text-xs ${failed ? "text-destructive" : "text-muted-foreground"}`}
        role="status"
      >
        {!failed ? (
          <span className="size-2 animate-pulse rounded-full bg-jade-text" aria-hidden />
        ) : null}
        {failed ? <Trans>Not created</Trans> : <Trans>Creating</Trans>}
      </p>
      {goal ? <p className="max-w-3xl whitespace-pre-wrap text-body">{goal}</p> : null}
      {failed ? (
        <>
          <p className="text-sm text-destructive" role="alert">
            <Trans>Couldn’t create this Work.</Trans>
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onRetry}>
              <Trans>Retry</Trans>
            </Button>
            <Button size="sm" variant="outline" onClick={onDiscard}>
              <Trans>Discard</Trans>
            </Button>
          </div>
        </>
      ) : null}
    </article>
  );
}
