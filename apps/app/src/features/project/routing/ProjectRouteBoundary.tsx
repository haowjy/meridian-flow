import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { DelayedContentSkeleton } from "@/components/app/DelayedContentSkeleton";
import { Button } from "@/components/ui/button";
import { DraftNoticeLine, useDiscardingNotice } from "@/features/draft-review/CommandNotice";
import { MainSurface } from "@/features/editor/MainSurface";
import { useItemLauncher } from "../review-launch";

export type ProjectRouteIssue = "loading" | "unavailable" | "error" | "resource-viewing";

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

export type ProjectRouteMask = {
  issue?: ProjectRouteIssue;
  retainWhileLoading?: boolean;
  destinationKey?: string;
  onRetry?: () => void;
  unavailable?: UnavailableReason;
};

export type UnavailableReason =
  | { kind: "removed"; documentId: string }
  | { kind: "in-draft"; file: ReviewFileTarget; draftId: string };

export function ProjectRouteBoundary({
  issue,
  children,
  retainWhileLoading = false,
  destinationKey,
  onRetry,
  unavailable,
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
            ) : unavailable?.kind === "removed" ? (
              <RemovedDestination documentId={unavailable.documentId} />
            ) : unavailable?.kind === "in-draft" ? (
              <OnlyInDraft file={unavailable.file} draftId={unavailable.draftId} />
            ) : (
              <Trans>This destination is unavailable.</Trans>
            )}
          </MainSurface>
        ) : null}
      </div>
    </div>
  );
}

function RemovedDestination({ documentId }: { documentId: string }) {
  const discarded = useDiscardingNotice(documentId);
  return discarded ? (
    <DraftNoticeLine notice={discarded} className="max-w-md" />
  ) : (
    <Trans>This destination is unavailable.</Trans>
  );
}

function OnlyInDraft({ file, draftId }: { file: ReviewFileTarget; draftId: string }) {
  const { openDraftFile } = useItemLauncher();
  return (
    <div className="flex flex-col items-center gap-3">
      <p>
        <Trans>Only in draft</Trans>
      </p>
      <Button size="sm" variant="outline" onClick={() => openDraftFile(file, draftId)}>
        <Trans>Open draft</Trans>
      </Button>
    </div>
  );
}
