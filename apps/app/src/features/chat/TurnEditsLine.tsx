/**
 * TurnEditsLine — the inert, per-turn record of what a turn EDITED.
 *
 * INVARIANT: record, not control panel — no draft affordance may be added here.
 * Review / Apply / Discard belong to the composer-attached DraftDock. The only
 * control this line ever carries is the transient `Undo` (a canon verb): it
 * folds the live-write undo/redo the old TurnChangeFooter owned, and hosts the
 * ephemeral "just applied" chip after a dock/editor Apply.
 *
 * Data source is a prop seam: `useTurnLiveLineage` passes live and draft
 * edited documents. Only live-scope rows carry undo authority.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ReversalOutcome, Turn } from "@meridian/contracts/protocol";
import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";

import type { ReversalDirection } from "@/client/api/reverse-api";
import { useUndoDraftAccept } from "@/client/query/useDraftReviewMutations";
import { useReverseTurnMutation } from "@/client/query/useReverseMutation";
import { displayContextPath } from "@/lib/context-uri";
import { cn } from "@/lib/utils";
import { useChatContextNavigation } from "./ChatContextNavigation";
import type { EphemeralUndoEntry } from "./ephemeral-undo-store";
import { useEphemeralUndoStore } from "./ephemeral-undo-store";

export type TurnEditDocument = {
  path: string;
  uri: string;
  scope: "live" | "draft";
};

export type TurnEditsLineProps = {
  threadId: string;
  turn: Turn;
  documents: TurnEditDocument[];
  /** Set only on the latest turn after a draft Apply — the transient chip host. */
  ephemeralUndo?: EphemeralUndoEntry | null;
};

type TurnDisposition = "applied" | "reversed" | "disabled";

export function TurnEditsLine({ threadId, turn, documents, ephemeralUndo }: TurnEditsLineProps) {
  const panelId = useId();
  const openContextUri = useChatContextNavigation();
  const [expanded, setExpanded] = useState(false);
  const [disposition, setDisposition] = useState<TurnDisposition>("applied");
  const [statusText, setStatusText] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const turnMutation = useReverseTurnMutation(threadId);

  // Live-lineage rows fold the whole-turn undo/redo chip in; draft rows are only a record.
  if (documents.length > 0) {
    const hasLiveDocuments = documents.some((document) => document.scope === "live");
    const direction: ReversalDirection = disposition === "reversed" ? "redo" : "undo";
    const multi = documents.length > 1;
    const label = documentCountLabel(documents.length);

    async function reverseTurn() {
      if (pending || disposition === "disabled") return;
      setPending(true);
      try {
        const outcome = await turnMutation.mutateAsync({ turnId: turn.id, direction });
        setDisposition(dispositionFromOutcome(direction, outcome));
        setStatusText(null);
      } catch (error) {
        setStatusText(errorMessage(error));
      } finally {
        setPending(false);
      }
    }

    return (
      <div className="mt-2 flex flex-col text-caption text-ink-subtle" data-turn-edits-line>
        <div className="flex min-h-6 items-center gap-1.5">
          {multi ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={panelId}
              aria-label={t`Show edited documents`}
              onClick={() => setExpanded((value) => !value)}
              className="focus-ring -ml-0.5 grid size-4 place-items-center rounded-sm"
            >
              <ChevronRight
                className={cn("size-3 transition-transform", expanded && "rotate-90")}
                aria-hidden
              />
            </button>
          ) : null}
          <span aria-hidden className="text-ink-subtle">
            ✎
          </span>
          <span className="min-w-0 truncate">
            {multi ? label : <Trans>Edited {basenameOf(documents[0])}</Trans>}
          </span>
          {!hasLiveDocuments || disposition === "disabled" ? null : (
            <button
              type="button"
              onClick={() => void reverseTurn()}
              disabled={pending}
              className="focus-ring ml-1 shrink-0 rounded-sm px-1 text-jade-text hover:text-foreground disabled:opacity-50"
            >
              {direction === "redo" ? t`Redo` : t`Undo`}
            </button>
          )}
          {statusText ? (
            <span className="truncate text-ink-subtle" role="alert">
              {statusText}
            </span>
          ) : null}
        </div>
        {multi && expanded ? (
          <ul id={panelId} className="mt-0.5 flex flex-col pl-6">
            {documents.map((doc) => (
              <li key={doc.uri} className="flex min-h-6 items-center">
                <DocumentName document={doc} onOpenContextUri={openContextUri} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  // No live-lineage record, but a dock/editor Apply just landed → ephemeral chip.
  if (ephemeralUndo) {
    return <EphemeralUndoLine entry={ephemeralUndo} />;
  }

  return null;
}

/**
 * The "just applied — Undo?" line. Session-local: navigation clears the store
 * (see ChatView), so this only ever shows for the most recent apply.
 */
function EphemeralUndoLine({ entry }: { entry: EphemeralUndoEntry }) {
  const undoAccept = useUndoDraftAccept();
  const clear = useEphemeralUndoStore((state) => state.clear);
  const name = entry.documentName;

  return (
    <div className="mt-2 flex min-h-6 items-center gap-1.5 text-caption text-ink-subtle">
      <span aria-hidden>✎</span>
      <span className="min-w-0 truncate">
        {name ? <Trans>Edited {name}</Trans> : <Trans>Applied changes</Trans>}
      </span>
      <button
        type="button"
        disabled={undoAccept.isPending}
        onClick={() => {
          undoAccept.mutate(
            {
              projectId: entry.projectId,
              workId: entry.workId,
              threadId: entry.threadId,
              documentId: entry.documentId,
              draftId: entry.draftId,
            },
            { onSettled: () => clear() },
          );
        }}
        className="focus-ring ml-1 shrink-0 rounded-sm px-1 text-jade-text hover:text-foreground disabled:opacity-50"
      >
        <Trans>Undo</Trans>
      </button>
    </div>
  );
}

function DocumentName({
  document,
  onOpenContextUri,
}: {
  document: TurnEditDocument;
  onOpenContextUri: ((uri: string) => void) | null;
}) {
  const label = basenameOf(document);
  if (!onOpenContextUri) {
    return <span className="min-w-0 truncate">{label}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => onOpenContextUri(document.uri)}
      className="focus-ring min-w-0 truncate rounded-sm text-left underline-offset-2 hover:underline"
    >
      {label}
    </button>
  );
}

function dispositionFromOutcome(
  direction: ReversalDirection,
  outcome: Pick<ReversalOutcome, "status">,
): TurnDisposition {
  if (outcome.status === "expired") return "disabled";
  if (direction === "undo") return "reversed";
  return "applied";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t`Undo failed`;
}

function documentCountLabel(count: number) {
  return count === 1 ? <Trans>Edited 1 document</Trans> : <Trans>Edited {count} documents</Trans>;
}

function basenameOf(document: TurnEditDocument): string {
  const display = displayContextPath(document.uri, document.path);
  const trimmed = display.replace(/\/+$/, "");
  const parts = trimmed.split("/").filter(Boolean);
  return parts.at(-1) ?? trimmed;
}
