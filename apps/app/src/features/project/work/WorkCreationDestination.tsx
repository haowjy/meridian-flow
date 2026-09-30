/** Pending and failed UI for a newly addressable Work. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WorkScreenHeader } from "./WorkDetailScreen";
import { PlainWorkHeading } from "./WorkTitles";

/** A Work still being created: its titles, its state, and Retry or Discard on failure. */
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
    <div className="app-scroll">
      <article className="project-screen-column min-w-0 gap-5 pb-12">
        <WorkScreenHeader
          intro={
            <>
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
            </>
          }
          view="chats"
          onViewChange={() => {}}
          pending
          tools={
            <>
              <div className="relative min-w-0 flex-1">
                <Input
                  type="search"
                  aria-label={t`Search chats`}
                  placeholder={t`Search chats`}
                  disabled
                  className="h-8 [@media(pointer:coarse)]:h-11"
                />
              </div>
              <Button size="sm" disabled className="[@media(pointer:coarse)]:min-h-11">
                <Trans>New chat</Trans>
              </Button>
            </>
          }
        />
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
        <p className="py-2 text-sm text-muted-foreground">
          <Trans>Chats in this Work share its goal and scratch files.</Trans>
        </p>
      </article>
    </div>
  );
}
