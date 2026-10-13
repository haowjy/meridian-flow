import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import type { WriterText } from "@meridian/thread-client";
import { Loader2 } from "lucide-react";
import { memo, useMemo } from "react";
import type { UserTurnRecovery } from "@/client/chat-submissions/presentation";
import { ErrorCard } from "@/components/app/ErrorCard";
import { Button } from "@/components/ui/button";
import { useOpenChatDocument } from "@/features/project/context/open-chat-document";
import { useProjectDocumentNavigationProjectId } from "@/features/project/context/open-project-document";
import { Markdown } from "@/rich-content/Markdown";
import { HandoffTurnAction, useTurnDerivation } from "./derivation/DeriveTurnActions";
import { useReferenceAvailability } from "./reference-availability";

export type UserTurnProps = {
  turn: Turn;
  /** The message's text with its reference and skill occurrences, from the view model. */
  writer: WriterText;
  /** True while the accepted writer turn has not yet been read by the model. */
  queued?: boolean;
  /** Retry and, after a durable server refusal, Edit on the unadmitted writer row. */
  submissionRecovery?: UserTurnRecovery | null;
};

function UserTurnComponent({
  turn,
  writer: projected,
  submissionRecovery = null,
  queued = false,
}: UserTurnProps) {
  // Hand off from a message the model has. A queued one sits beyond the
  // cutoff the server would use, so it offers none.
  const handoff = useTurnDerivation() !== null && !queued && turn.status === "complete";
  const projectId = useProjectDocumentNavigationProjectId();
  const openDocument = useOpenChatDocument(projectId ?? undefined);
  const resolutions = useReferenceAvailability(
    useMemo(
      () => [...new Set(projected.references.map(({ documentId }) => documentId))],
      [projected.references],
    ),
  );

  return (
    <article
      className="user-turn"
      data-turn-id={turn.id}
      data-turn-role="user"
      aria-label={t`Your message`}
    >
      <div className="user-message-bubble">
        <Markdown
          breaks
          references={projected.references}
          skills={projected.skills}
          referenceResolutions={resolutions}
          onOpenReference={(documentId) =>
            void openDocument({ documentId, disposition: "current" })
          }
        >
          {projected.text}
        </Markdown>
      </div>
      {turn.status === "pending" ? (
        <p
          data-user-turn-status="pending"
          role="status"
          className="mt-[var(--chat-space-inline)] flex items-center justify-end gap-[var(--chat-space-inline)] text-xs text-muted-foreground"
        >
          <Loader2 className="size-3 animate-spin" aria-hidden />
          {t`Sending`}
        </p>
      ) : null}
      {queued && turn.status !== "pending" && turn.status !== "error" ? (
        <p
          data-user-turn-status="queued"
          role="status"
          className="mt-[var(--chat-space-inline)] text-right text-xs text-muted-foreground"
        >
          {t`Queued`}
        </p>
      ) : null}
      {turn.status === "error" && submissionRecovery?.moving ? (
        <p
          data-user-turn-status="error"
          role="status"
          className="mt-[var(--chat-space-inline)] text-right text-xs text-muted-foreground"
        >
          {t`Moved to the message box.`}
        </p>
      ) : null}
      {turn.status === "error" && !submissionRecovery?.moving ? (
        // Zero intrinsic width so a short message's bubble does not stretch to the card;
        // the card right-aligns inside the row and overhangs to the left.
        <div className="mt-[var(--chat-space-block)] flex w-0 min-w-full justify-end">
          {/* The chat announces the failure once through its own assertive region, and a
              rejection restored on reload must stay silent, so the card is not an alert. */}
          <ErrorCard inline announce={false}>
            <p data-user-turn-status="error" role="status">
              {t`Couldn't send.`}
            </p>
            {submissionRecovery?.onRetry ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={submissionRecovery.onRetry}
              >
                {t`Retry`}
              </Button>
            ) : null}
            {submissionRecovery?.onEdit ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={submissionRecovery.busy}
                onClick={submissionRecovery.onEdit}
              >
                {t`Edit`}
              </Button>
            ) : null}
          </ErrorCard>
        </div>
      ) : null}
      {handoff ? (
        // A row under the bubble on its right edge, like a reply's actions; revealed
        // on hover or focus with a mouse, always shown on touch (globals.css).
        <div
          className="user-turn-actions mt-[var(--chat-space-inline)] flex min-h-6 items-center justify-end gap-[var(--chat-space-inline)] transition-opacity"
          data-user-turn-actions
        >
          <HandoffTurnAction turnId={turn.id} />
        </div>
      ) : null}
    </article>
  );
}

export const UserTurn = memo(
  UserTurnComponent,
  (prev, next) =>
    prev.turn === next.turn &&
    prev.writer === next.writer &&
    prev.submissionRecovery === next.submissionRecovery &&
    prev.queued === next.queued,
);
UserTurn.displayName = "UserTurn";
