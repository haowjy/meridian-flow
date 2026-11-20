/** Retain usable content during document navigation; mask unavailable destinations. */
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { DelayedContentSkeleton } from "@/components/app/DelayedContentSkeleton";
import { Button } from "@/components/ui/button";
import type { Bounce } from "@/core/project-tree/tree-undo";
import { DraftNoticeLine, useDiscardingNotice } from "@/features/draft-review/CommandNotice";
import { MainSurface } from "@/features/editor/MainSurface";
import { type Removal, RemovedDocumentSentence } from "../context/RemovedDocumentNotice";
import { bounceSaying } from "../context/use-tree-notice-words";
import { useShellTreeVersion } from "../tree-version";

export type ProjectRouteIssue = "loading" | "unavailable" | "error" | "resource-viewing";

/** Whether the destination body is masked. */
export function isProjectRouteMasked({
  issue,
  retainWhileLoading = false,
}: {
  issue?: ProjectRouteIssue;
  retainWhileLoading?: boolean;
}): boolean {
  const retainedPending = issue === "loading" && retainWhileLoading;
  return !!issue && !retainedPending;
}

/** What masks a destination's body. Its navigation frame is composed outside the boundary. */
export type ProjectRouteMask = {
  issue?: ProjectRouteIssue;
  retainWhileLoading?: boolean;
  destinationKey?: string;
  /** Offered with a failed destination: the address stays, only its reads run again. */
  onRetry?: () => void;
  /**
   * An unavailable destination whose document was removed says who removed it, or shows the
   * Discard's notice, with its Undo, while one can bring it back. One the server never created
   * (`bounce`: its Work was closed) says so, with what the writer typed and the row's Copy.
   */
  removed?: Removal & { documentId: string; bounce?: Bounce };
};

export function ProjectRouteBoundary({
  issue,
  children,
  retainWhileLoading = false,
  destinationKey,
  onRetry,
  removed,
}: ProjectRouteMask & { children: ReactNode }) {
  const blocked = isProjectRouteMasked({ issue, retainWhileLoading });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col" aria-busy={issue === "loading"}>
        <div
          className="flex min-h-0 flex-1 flex-col"
          inert={blocked}
          aria-hidden={blocked}
          style={blocked ? { visibility: "hidden" } : undefined}
        >
          {children}
        </div>
        {issue === "loading" ? (
          blocked && <DelayedContentSkeleton key={destinationKey} className="absolute inset-0" />
        ) : issue ? (
          <MainSurface
            joined
            className="absolute inset-0 grid place-items-center bg-background px-6 text-center text-sm text-muted-foreground"
            role="status"
          >
            {issue === "error" && onRetry ? (
              <div className="flex flex-col items-center gap-3">
                <p>
                  <Trans>This destination couldn’t load.</Trans>
                </p>
                <Button size="sm" variant="outline" onClick={onRetry}>
                  <Trans>Retry</Trans>
                </Button>
              </div>
            ) : issue === "resource-viewing" ? (
              <Trans>Not available</Trans>
            ) : issue === "error" ? (
              <Trans>This destination couldn’t load.</Trans>
            ) : removed ? (
              <RemovedDestination removed={removed} />
            ) : (
              <Trans>This destination is unavailable.</Trans>
            )}
          </MainSurface>
        ) : null}
      </div>
    </div>
  );
}

function RemovedDestination({
  removed,
}: {
  removed: Removal & { documentId: string; bounce?: Bounce };
}) {
  const discarded = useDiscardingNotice(removed.documentId);
  if (removed.bounce) return <NotCreatedDestination bounce={removed.bounce} />;
  return discarded ? (
    <DraftNoticeLine notice={discarded} className="max-w-md" />
  ) : (
    <p className="max-w-md break-words">
      <RemovedDocumentSentence documents={[removed]} />
    </p>
  );
}

function NotCreatedDestination({ bounce }: { bounce: Bounce }) {
  const { word, sentence, copy } = bounceSaying(bounce, useShellTreeVersion()?.name ?? null);
  return (
    <div className="flex max-w-xl flex-col items-center gap-3">
      <p className="break-words">
        {copy ? (
          sentence
        ) : (
          <>
            {word}. {sentence}
          </>
        )}
      </p>
      {bounce.typed ? (
        <div className="max-h-64 w-full overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-4 py-3 text-left text-foreground">
          {bounce.typed}
        </div>
      ) : null}
      {copy ? (
        <Button size="sm" variant="outline" aria-label={copy.label} onClick={copy.take}>
          {copy.word}
        </Button>
      ) : null}
    </div>
  );
}
