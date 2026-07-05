/**
 * TurnEditsCard — the inert, per-turn record of what a turn EDITED.
 *
 * INVARIANT: record, not control panel — no draft affordance may be added here.
 * Review / Apply / Discard belong to the composer-attached DraftDock. The only
 * control this card ever carries is the transient `Undo` (a canon verb): it
 * folds the live-write undo/redo the old TurnChangeFooter owned, and hosts the
 * ephemeral "just applied" chip after a dock/editor Apply.
 *
 * Shape: a collapsed card at the end of every turn that edited documents
 * (created files count — they produce mutation rows like any edit). The header
 * carries only the document count; expanding lists each document.
 *
 * Data source is a prop seam: `useTurnLiveLineage` passes live and draft
 * edited documents. Only live-scope rows carry undo authority.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ReversalOutcome, Turn } from "@meridian/contracts/protocol";
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";

import type { ReversalDirection } from "@/client/api/reverse-api";
import { useUndoDraftAccept } from "@/client/query/useDraftReviewMutations";
import { useReverseTurnMutation } from "@/client/query/useReverseMutation";
import { Button } from "@/components/ui/button";
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

export type TurnEditsCardProps = {
  threadId: string;
  turn: Turn;
  documents: TurnEditDocument[];
  /** Set only on the latest turn after a draft Apply — the transient chip host. */
  ephemeralUndo?: EphemeralUndoEntry | null;
};

type TurnDisposition = "applied" | "reversed" | "disabled";

export function TurnEditsCard({ threadId, turn, documents, ephemeralUndo }: TurnEditsCardProps) {
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
      // overflow-hidden clips the header hover wash to the card radius.
      <div
        className="mt-3 overflow-hidden rounded-lg border border-border bg-card text-caption text-ink-muted"
        data-turn-edits-card
      >
        {/* The WHOLE header row is the expand/collapse target — hover washes the
            full width, wrapping around the Undo chip, which fences its own click. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the inner button is the keyboard-accessible toggle; the row onClick is a mouse convenience. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: same — mouse-convenience toggle over a semantic inner button. */}
        <div
          onClick={() => setExpanded((value) => !value)}
          className="flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors hover:bg-surface-subtle"
        >
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((value) => !value);
            }}
            className="focus-ring -mx-1 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left"
          >
            <ChevronDown
              className={cn(
                "size-3.5 shrink-0 text-ink-subtle transition-transform",
                expanded && "rotate-180",
              )}
              aria-hidden
            />
            <span aria-hidden className="text-ink-subtle">
              ✎
            </span>
            <span className="min-w-0 flex-1 truncate font-medium text-ink-strong">
              {documentCountLabel(documents.length)}
            </span>
          </button>
          {hasLiveDocuments && disposition !== "disabled" ? (
            <Button
              type="button"
              variant="quiet"
              size="meta"
              onClick={(event) => {
                event.stopPropagation();
                void reverseTurn();
              }}
              disabled={pending}
              className="shrink-0 text-jade-text"
            >
              {direction === "redo" ? t`Redo` : t`Undo`}
            </Button>
          ) : null}
          {!hasLiveDocuments && ephemeralUndo ? <EphemeralUndoChip entry={ephemeralUndo} /> : null}
        </div>
        {statusText ? (
          <p className="truncate px-3 pb-2 text-ink-subtle" role="alert">
            {statusText}
          </p>
        ) : null}
        {expanded ? (
          <ul
            id={panelId}
            className="flex flex-col gap-0.5 border-border-subtle border-t px-3 py-1.5"
          >
            {documents.map((doc) => (
              <li key={doc.uri} className="flex min-h-6 items-center pl-6">
                <DocumentName document={doc} onOpenContextUri={openContextUri} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  // No lineage record, but a dock/editor Apply just landed → minimal chip line.
  if (ephemeralUndo) {
    return (
      <div className="mt-2 flex min-h-6 items-center gap-1.5 text-caption text-ink-subtle">
        <span aria-hidden>✎</span>
        <span className="min-w-0 truncate">
          {ephemeralUndo.documentName ? (
            <Trans>Edited {ephemeralUndo.documentName}</Trans>
          ) : (
            <Trans>Applied changes</Trans>
          )}
        </span>
        <EphemeralUndoChip entry={ephemeralUndo} />
      </div>
    );
  }

  return null;
}

/**
 * The "just applied — Undo?" chip. Session-local: navigation clears the store
 * (see ChatView), so this only ever shows for the most recent apply.
 */
function EphemeralUndoChip({ entry }: { entry: EphemeralUndoEntry }) {
  const undoAccept = useUndoDraftAccept();
  const clear = useEphemeralUndoStore((state) => state.clear);

  return (
    <Button
      type="button"
      variant="quiet"
      size="meta"
      disabled={undoAccept.isPending}
      onClick={(event) => {
        // Fences the card-header toggle when the chip rides the header row.
        event.stopPropagation();
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
      className="shrink-0 text-jade-text"
    >
      <Trans>Undo</Trans>
    </Button>
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
    return <span className="min-w-0 truncate text-ink-strong">{label}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => onOpenContextUri(document.uri)}
      className="focus-ring min-w-0 truncate rounded-sm text-left text-ink-strong underline-offset-2 hover:underline"
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
