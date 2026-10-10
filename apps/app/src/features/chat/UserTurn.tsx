import { t } from "@lingui/core/macro";
import {
  referenceOccurrenceContent,
  skillOccurrenceContent,
  type Turn,
} from "@meridian/contracts/protocol";
import { Loader2 } from "lucide-react";
import { memo, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { useOpenChatDocument } from "@/features/project/context/open-chat-document";
import { useProjectDocumentNavigationProjectId } from "@/features/project/context/open-project-document";
import { Markdown } from "@/rich-content/Markdown";
import type {
  MarkdownReferenceOccurrence,
  MarkdownSkillOccurrence,
} from "@/rich-content/reference-occurrences";
import { HandoffTurnAction, useTurnDerivation } from "./derivation/DeriveTurnActions";
import { useReferenceAvailability } from "./reference-availability";

export type UserTurnRecovery =
  | {
      kind: "ambiguous";
      onCheck: () => void;
      onRetire: () => void;
    }
  | {
      kind: "rejected";
      onRetry: () => void;
      /** Move rejected words into the composer without replacing newer writing. */
      onEdit?: () => void;
    };

export type UserTurnProps = {
  turn: Turn;
  /** True while the accepted writer turn has not yet been read by the model. */
  queued?: boolean;
  /** Check submission status / Start over for a recovered ambiguous send. */
  submissionRecovery?: UserTurnRecovery | null;
};

export function projectUserTurn(turn: Turn): {
  text: string;
  references: MarkdownReferenceOccurrence[];
  skills: MarkdownSkillOccurrence[];
} {
  let text = "";
  const references: MarkdownReferenceOccurrence[] = [];
  const skills: MarkdownSkillOccurrence[] = [];
  for (const block of [...turn.blocks].sort((a, b) => a.sequence - b.sequence)) {
    if (block.blockType !== "text") continue;
    const skill = skillOccurrenceContent(block);
    const occurrence = referenceOccurrenceContent(block);
    const chunk = skill?.text ?? occurrence?.text ?? block.textContent ?? "";
    const from = text.length;
    text += chunk;
    if (skill)
      skills.push({
        from,
        to: text.length,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
      });
    if (occurrence)
      references.push({
        from,
        to: text.length,
        documentId: occurrence.documentId,
        uri: occurrence.uri,
      });
  }
  return { text, references, skills };
}

function UserTurnComponent({ turn, submissionRecovery = null, queued = false }: UserTurnProps) {
  // Hand off from a message the model has. A queued one sits beyond the
  // cutoff the server would use, so it offers none.
  const handoff = useTurnDerivation() !== null && !queued && turn.status === "complete";
  const projectId = useProjectDocumentNavigationProjectId();
  const openDocument = useOpenChatDocument(projectId ?? undefined);
  const projected = useMemo(() => projectUserTurn(turn), [turn]);
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
      {turn.status === "error" ? (
        <p
          data-user-turn-status="error"
          role="status"
          className="mt-[var(--chat-space-inline)] text-right text-xs text-destructive"
        >
          {t`Couldn't send.`}
        </p>
      ) : null}
      {submissionRecovery?.kind === "ambiguous" ? (
        <div className="mt-[var(--chat-space-inline)] flex justify-end gap-[var(--chat-space-inline)]">
          <Button type="button" variant="quiet" size="sm" onClick={submissionRecovery.onCheck}>
            {t`Check submission status`}
          </Button>
          <Button type="button" variant="quiet" size="sm" onClick={submissionRecovery.onRetire}>
            {t`Start over`}
          </Button>
        </div>
      ) : null}
      {submissionRecovery?.kind === "rejected" ? (
        <div className="mt-[var(--chat-space-inline)] flex justify-end gap-[var(--chat-space-inline)]">
          <Button type="button" variant="quiet" size="sm" onClick={submissionRecovery.onRetry}>
            {t`Retry`}
          </Button>
          {submissionRecovery.onEdit ? (
            <Button type="button" variant="quiet" size="sm" onClick={submissionRecovery.onEdit}>
              {t`Edit`}
            </Button>
          ) : null}
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
    prev.submissionRecovery === next.submissionRecovery &&
    prev.queued === next.queued,
);
UserTurn.displayName = "UserTurn";
