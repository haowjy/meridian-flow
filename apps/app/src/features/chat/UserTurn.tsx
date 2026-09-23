import { t } from "@lingui/core/macro";
import {
  referenceOccurrenceContent,
  skillOccurrenceContent,
  type Turn,
} from "@meridian/contracts/protocol";
import { Loader2 } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import { lookupProjectContextAvailability } from "@/client/query/project-context-availability";
import { Button } from "@/components/ui/button";
import {
  useOpenProjectDocument,
  useProjectDocumentNavigationProjectId,
} from "@/features/project/context/open-project-document";
import { Markdown } from "@/rich-content/Markdown";
import type {
  MarkdownReferenceOccurrence,
  MarkdownSkillOccurrence,
} from "@/rich-content/reference-occurrences";
import type { TranscriptReferenceResolution } from "@/rich-content/TranscriptReference";

export type UserTurnRecovery =
  | {
      kind: "ambiguous";
      onCheck: () => void;
      onRetire: () => void;
    }
  | {
      kind: "rejected";
      onRetry: () => void;
      /**
       * Focus or restore the retained draft. Absent when only Retry is honest:
       * a structured rejection whose live draft is gone cannot be rebuilt from
       * its text without admitting a different message.
       */
      onEdit?: () => void;
    };

export type UserTurnProps = {
  turn: Turn;
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

function UserTurnComponent({ turn, submissionRecovery = null }: UserTurnProps) {
  const projectId = useProjectDocumentNavigationProjectId();
  const openDocument = useOpenProjectDocument(projectId ?? undefined);
  const projected = useMemo(() => projectUserTurn(turn), [turn]);
  const [resolutions, setResolutions] = useState<
    ReadonlyMap<string, TranscriptReferenceResolution>
  >(new Map());
  useEffect(() => {
    const ids = [...new Set(projected.references.map(({ documentId }) => documentId))];
    if (!projectId || ids.length === 0) {
      setResolutions(new Map());
      return;
    }
    let current = true;
    void lookupProjectContextAvailability(projectId, ids)
      .then((result) => {
        if (!current) return;
        setResolutions(
          new Map(
            result.resolutions.flatMap((resolution) =>
              resolution.kind === "available"
                ? [
                    [
                      resolution.documentId,
                      {
                        documentId: resolution.documentId,
                        uri: resolution.entry.uri,
                        label: resolution.entry.name,
                        available: true,
                      },
                    ] as const,
                  ]
                : [],
            ),
          ),
        );
      })
      .catch(() => {
        if (current) setResolutions(new Map());
      });
    return () => {
      current = false;
    };
  }, [projectId, projected.references]);

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
          className="mt-1 flex items-center justify-end gap-1.5 text-xs text-muted-foreground"
        >
          <Loader2 className="size-3 animate-spin" aria-hidden />
          {t`Sending`}
        </p>
      ) : null}
      {turn.status === "error" ? (
        <p
          data-user-turn-status="error"
          role="status"
          className="mt-1 text-right text-xs text-destructive"
        >
          {t`Couldn't send.`}
        </p>
      ) : null}
      {submissionRecovery?.kind === "ambiguous" ? (
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="quiet" size="sm" onClick={submissionRecovery.onCheck}>
            {t`Check submission status`}
          </Button>
          <Button type="button" variant="quiet" size="sm" onClick={submissionRecovery.onRetire}>
            {t`Start over`}
          </Button>
        </div>
      ) : null}
      {submissionRecovery?.kind === "rejected" ? (
        <div className="mt-1 flex justify-end gap-2">
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
    </article>
  );
}

export const UserTurn = memo(
  UserTurnComponent,
  (prev, next) => prev.turn === next.turn && prev.submissionRecovery === next.submissionRecovery,
);
UserTurn.displayName = "UserTurn";
