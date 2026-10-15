import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import type { WriterText } from "@meridian/thread-client";
import { Loader2, X } from "lucide-react";
import { memo, useMemo } from "react";
import type { UserTurnRecovery } from "@/client/chat-submissions/presentation";
import { NoticeCard } from "@/components/app/NoticeCard";
import { Button } from "@/components/ui/button";
import { useOpenChatDocument } from "@/features/project/context/open-chat-document";
import { useProjectDocumentNavigationProjectId } from "@/features/project/context/open-project-document";
import { Markdown } from "@/rich-content/Markdown";
import { HandoffTurnAction, useTurnDerivation } from "./derivation/DeriveTurnActions";
import { useReferenceAvailability } from "./reference-availability";
import type { TurnQueueControls } from "./TurnList";

export type UserTurnProps = {
  turn: Turn;
  /** The message's text with its reference and skill occurrences, from the view model. */
  writer: WriterText;
  /** True while the accepted writer turn has not yet been read by the model. */
  queued?: boolean;
  /** The x, and on the last queued row Cancel queue and Send now. Null on rows that aren't the writer's queue. */
  queueControls?: TurnQueueControls | null;
  /** This is the last queued row, which carries Cancel queue and Send now. */
  lastQueued?: boolean;
  queuedCount?: number;
  /** Retry and, after a durable server refusal, Edit on the unadmitted writer row. */
  submissionRecovery?: UserTurnRecovery | null;
};

function UserTurnComponent({
  turn,
  writer: projected,
  submissionRecovery = null,
  queued = false,
  queueControls = null,
  lastQueued = false,
  queuedCount = 0,
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

  const queuedRow = queued && turn.status !== "pending" && turn.status !== "error";
  const content = (
    <Markdown
      breaks
      references={projected.references}
      skills={projected.skills}
      referenceResolutions={resolutions}
      onOpenReference={(documentId) => void openDocument({ documentId, disposition: "current" })}
    >
      {projected.text}
    </Markdown>
  );

  return (
    <article
      className="user-turn"
      data-turn-id={turn.id}
      data-turn-role="user"
      aria-label={queuedRow ? t`Your message, queued` : t`Your message`}
      data-queued={queuedRow ? "" : undefined}
    >
      {queuedRow && queueControls ? (
        // The x sits beside the bubble, centred on it; the bubble gives up width for it.
        <div className="flex items-center justify-end gap-[var(--chat-space-inline)]">
          <div className="user-message-bubble min-w-0">{content}</div>
          <Button
            type="button"
            variant="quiet"
            size="icon-xs"
            data-queue-control="move-to-box"
            aria-label={t`Move to the message box`}
            className="shrink-0 [@media(pointer:coarse)]:size-11"
            onClick={() => queueControls.remove(turn.id)}
          >
            <X aria-hidden />
          </Button>
        </div>
      ) : (
        <div className="user-message-bubble">{content}</div>
      )}
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
      {queuedRow &&
      queueControls &&
      lastQueued &&
      (queuedCount >= 2 || queueControls.sendNow.available) ? (
        <div className="mt-[var(--chat-space-inline)] flex flex-wrap items-center justify-end gap-x-[var(--chat-space-block)] text-xs text-muted-foreground">
          {queuedCount >= 2 ? (
            <Button
              type="button"
              variant="quiet"
              size="meta"
              data-queue-control="cancel-queue"
              className="[@media(pointer:coarse)]:min-h-11"
              onClick={queueControls.cancelQueue}
            >
              {t`Cancel queue`}
            </Button>
          ) : null}
          {queueControls.sendNow.available ? (
            <Button
              type="button"
              variant="quiet"
              size="meta"
              data-queue-control="send-now"
              data-busy={queueControls.sendNow.busy ? "" : undefined}
              disabled={queueControls.sendNow.busy}
              aria-label={t`Stop the reply and send now`}
              className="[@media(pointer:coarse)]:min-h-11"
              onClick={queueControls.sendNow.send}
            >
              {queueControls.sendNow.busy ? (
                <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden />
              ) : null}
              {t`Send now`}
            </Button>
          ) : null}
        </div>
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
          <NoticeCard tone="error" inline announce={false}>
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
          </NoticeCard>
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
    prev.queued === next.queued &&
    prev.queueControls === next.queueControls &&
    prev.lastQueued === next.lastQueued &&
    prev.queuedCount === next.queuedCount,
);
UserTurn.displayName = "UserTurn";
