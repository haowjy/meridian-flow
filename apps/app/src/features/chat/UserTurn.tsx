import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import type { WriterText } from "@meridian/thread-client";
import { Loader2, Pencil, X } from "lucide-react";
import { memo, useMemo } from "react";
import type { UserTurnRecovery } from "@/client/chat-submissions/presentation";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useProjectDocumentNavigationProjectId } from "@/features/project/context/open-project-document";
import { useOpenPlacedDocument } from "@/features/project/review-launch";
import { Markdown } from "@/rich-content/Markdown";
import { referenceKey } from "@/rich-content/TranscriptReference";
import { AnchoredCards } from "./ChatCards";
import { HandoffTurnAction, useTurnDerivation } from "./derivation/DeriveTurnActions";
import { useReferenceAvailability } from "./reference-availability";
import type { TurnQueueControls } from "./TurnList";
import { TURN_ACTION_TOOLTIP_SIDE } from "./turn-action-tooltip";

export type UserTurnProps = {
  turn: Turn;
  writer: WriterText;
  queued?: boolean;
  queueControls?: TurnQueueControls | null;
  lastQueued?: boolean;
  queuedCount?: number;
  submissionRecovery?: UserTurnRecovery | null;
  onEdit?: ((turnId: string) => void) | null;
};

function UserTurnComponent({
  turn,
  writer: projected,
  submissionRecovery = null,
  queued = false,
  queueControls = null,
  lastQueued = false,
  queuedCount = 0,
  onEdit = null,
}: UserTurnProps) {
  const handoff = useTurnDerivation() !== null && !queued && turn.status === "complete";
  const projectId = useProjectDocumentNavigationProjectId();
  const openDocument = useOpenPlacedDocument(projectId ?? undefined);
  const resolutions = useReferenceAvailability(
    useMemo(
      () => [
        ...new Set(
          projected.references.map((reference) =>
            reference.kind === "document"
              ? referenceKey("document", reference.documentId)
              : referenceKey("folder", reference.folderId),
          ),
        ),
      ],
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
      onOpenReference={(documentId) => void openDocument(documentId)}
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
        <div className="flex items-center justify-end gap-[var(--chat-space-inline)]">
          <div className="user-message-bubble min-w-0">{content}</div>
          <IconButton
            type="button"
            data-queue-control="move-to-box"
            label={t`Move to the message box`}
            className="shrink-0"
            onClick={() => queueControls.remove(turn.id)}
          >
            <X aria-hidden />
          </IconButton>
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
        <AnchoredCards
          anchor={{ message: turn.id }}
          recovery={submissionRecovery}
          wrapClassName="mt-[var(--chat-space-block)] flex w-0 min-w-full justify-end"
        />
      ) : null}
      {handoff || onEdit ? (
        <div
          className="user-turn-actions mt-[var(--chat-space-inline)] flex min-h-6 items-center justify-end gap-[var(--chat-space-inline)] transition-opacity"
          data-user-turn-actions
        >
          {onEdit ? (
            <IconButton
              type="button"
              label={t`Edit in the message box`}
              tooltipSide={TURN_ACTION_TOOLTIP_SIDE}
              data-user-turn-action="edit"
              onClick={() => onEdit(turn.id)}
            >
              <Pencil aria-hidden />
            </IconButton>
          ) : null}
          {handoff ? <HandoffTurnAction turnId={turn.id} /> : null}
        </div>
      ) : null}
    </article>
  );
}

export const UserTurn = memo(UserTurnComponent);
UserTurn.displayName = "UserTurn";
