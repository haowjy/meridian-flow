/**
 * DraftReviewCard — one-line docked bar for a chat's AI drafts.
 *
 * The card renders above the composer (unanchored variant) or under an
 * assistant turn (inline variant). It carries one signal — "<doc> has
 * changes" — and one primary action, **Review**, which routes through
 * `useAiDraftLauncher` into inline review (jumping to Context view +
 * collapsing rails on the way). Apply / Discard are compact secondaries.
 *
 * The live manuscript is NEVER touched until the writer accepts; copy
 * reflects that literally. No reassurance blurbs, no eyebrow, no icon.
 *
 * Terminal states (applied / discarded) collapse to a compact "state +
 * Undo" row — never transcript prose. If the draft is gone entirely
 * (undo window expired), the row explains why briefly.
 */
import { Trans } from "@lingui/react/macro";
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { Loader2, RotateCcw } from "lucide-react";

import { isDraftUndoable } from "@/client/query/draft-undoable";
import { useUndoDraftAccept, useUndoDraftReject } from "@/client/query/useDraftReviewMutations";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { useDraftReview } from "./DraftReviewProvider";
import { useAiDraftLauncher } from "./useAiDraftLauncher";
import type { DraftReviewController } from "./useDraftReviewController";

export type DraftReviewCardProps = {
  group: ThreadDraftGroup;
  /** Visual variant: anchored under an assistant turn, or docked above the
   *  composer (the unanchored fallback strip). Docked variant renders with
   *  no outer margin so the ChatView can stack it directly above Composer. */
  variant?: "inline" | "compact";
};

export function DraftReviewCard({ group, variant = "inline" }: DraftReviewCardProps) {
  const { controller, reviewableDraftsForGroup, nowMs } = useDraftReview();
  const undoAccept = useUndoDraftAccept();
  const undoReject = useUndoDraftReject();
  const { openAiDraft } = useAiDraftLauncher();
  const { visible: reviewableDrafts, active: activeDrafts } = reviewableDraftsForGroup(group);

  if (reviewableDrafts.length === 0) return null;

  const busy = controller.isPending || undoAccept.isPending || undoReject.isPending;

  function handleUndo(draft: ThreadDraftListItem) {
    if (draft.status === "active" || busy || !isDraftUndoable(draft, nowMs)) return;
    const mutation = draft.status === "applied" ? undoAccept : undoReject;
    mutation.mutate({
      projectId: controller.projectId,
      workId: controller.workId,
      documentId: group.documentId,
      draftId: draft.draftId,
    });
  }

  return (
    <div
      className="flex flex-col gap-1"
      data-draft-card
      data-document-id={group.documentId}
      data-variant={variant}
    >
      {reviewableDrafts.map((draft) => (
        <DraftRow
          key={draft.draftId}
          draft={draft}
          group={group}
          activeCount={activeDrafts.length}
          controller={controller}
          busy={busy}
          nowMs={nowMs}
          onOpen={openAiDraft}
          onUndo={handleUndo}
          variant={variant}
        />
      ))}
    </div>
  );
}

function DraftRow({
  draft,
  group,
  activeCount,
  controller,
  busy,
  nowMs,
  onOpen,
  onUndo,
  variant,
}: {
  draft: ThreadDraftListItem;
  group: Pick<ThreadDraftGroup, "documentId" | "documentName">;
  activeCount: number;
  controller: DraftReviewController;
  busy: boolean;
  nowMs: number;
  onOpen: (group: Pick<ThreadDraftGroup, "documentId" | "documentName">, draftId: string) => void;
  onUndo: (draft: ThreadDraftListItem) => void;
  variant: "inline" | "compact";
}) {
  const documentName = group.documentName ?? draft.documentName;

  // One-line docked shell: full border, no side stripe, subtle shadow —
  // matches the surface-card language. Inline variant grows a top margin
  // so it detaches from the assistant turn above.
  const shell = cn(
    "flex min-w-0 items-center gap-2 rounded-md border border-border-subtle bg-card px-3 py-1.5 shadow-xs",
    variant === "inline" && "mt-3",
  );

  if (draft.status === "active") {
    // Signal + primary + compact overflow. "Apply" and "Discard" remain
    // reachable but are quieter than Review — never peer-weight with it.
    return (
      <div className={shell} data-draft-status="active">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
        <span className="min-w-0 truncate text-sm text-foreground">
          {documentName ? (
            activeCount > 1 ? (
              <Trans>
                <span className="font-medium">{documentName}</span> has {activeCount} pending
                changes
              </Trans>
            ) : (
              <Trans>
                <span className="font-medium">{documentName}</span> has changes
              </Trans>
            )
          ) : (
            <Trans>Document has changes</Trans>
          )}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => controller.reject(group.documentId, draft.draftId)}
            disabled={busy}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trans>Discard</Trans>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => controller.accept(group.documentId, draft.draftId)}
            disabled={busy}
            className="text-muted-foreground hover:text-foreground"
          >
            {controller.isAccepting ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : null}
            <Trans>Apply</Trans>
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => onOpen(group, draft.draftId)}
            disabled={busy}
          >
            <Trans>Review</Trans>
          </Button>
        </div>
      </div>
    );
  }

  // Terminal state: compact undo bar. No ids, no counts we cannot back
  // up honestly, no timestamps competing with the signal.
  const isApplied = draft.status === "applied";
  const undoable = isDraftUndoable(draft, nowMs);

  return (
    <div className={shell} data-draft-status={draft.status}>
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isApplied ? "bg-primary" : "bg-muted-foreground",
        )}
      />
      <span className="min-w-0 truncate text-sm text-foreground">
        {documentName ? (
          isApplied ? (
            <Trans>
              Changes applied to <span className="font-medium">{documentName}</span>
            </Trans>
          ) : (
            <Trans>
              Discarded changes to <span className="font-medium">{documentName}</span>
            </Trans>
          )
        ) : isApplied ? (
          <Trans>Changes applied</Trans>
        ) : (
          <Trans>Discarded changes</Trans>
        )}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {undoable ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onUndo(draft)}
            disabled={busy}
            className="text-muted-foreground hover:text-foreground"
          >
            {busy ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <RotateCcw className="size-3" aria-hidden />
            )}
            <Trans>Undo</Trans>
          </Button>
        ) : (
          <span className="text-muted-foreground text-xs">
            <Trans>Undo window closed</Trans>
          </span>
        )}
      </div>
    </div>
  );
}
