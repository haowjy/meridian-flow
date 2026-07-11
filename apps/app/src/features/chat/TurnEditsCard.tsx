/**
 * TurnEditsCard — the inert, per-turn record of what a turn EDITED.
 *
 * INVARIANT: record, not control panel — no draft affordance may be added here.
 * Review / Apply / Discard belong to the composer-attached DraftDock. The only
 * control this card ever carries is the transient `Undo` (a canon verb): it
 * folds the live-write undo/redo the old TurnChangeFooter owned.
 *
 * Shape: a collapsed card at the end of every turn that edited documents
 * (created files count — they produce mutation rows like any edit). The header
 * carries only the document count; expanding lists each document.
 *
 * Data source is a prop seam: `useTurnLiveLineage` passes live and draft
 * edited documents. Any lineage row carries undo authority; the endpoint routes
 * the operation to the matching live or draft journal per document.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Turn, TurnReceiptChip } from "@meridian/contracts/protocol";
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";

import type { ReversalDirection } from "@/client/api/reverse-api";
import { useReverseTurnMutation } from "@/client/query/useReverseMutation";
import { Button } from "@/components/ui/button";
import { displayContextPath } from "@/lib/context-uri";
import { cn } from "@/lib/utils";
import { useChatContextNavigation } from "./ChatContextNavigation";

export type TurnEditDocument = {
  path: string;
  uri: string;
  scope: "live" | "draft";
};

export type TurnEditsCardProps = {
  threadId: string;
  turn: Turn;
  documents: TurnEditDocument[];
  receipt: TurnReceiptChip | null;
};

export function TurnEditsCard({ threadId, turn, documents, receipt }: TurnEditsCardProps) {
  const panelId = useId();
  const openContextUri = useChatContextNavigation();
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const turnMutation = useReverseTurnMutation(threadId);

  const hasEditedDocuments = documents.length > 0;
  const direction: ReversalDirection = receipt?.control === "redo" ? "redo" : "undo";

  async function reverseTurn() {
    if (pending || !receipt || receipt.control === "view_change") return;
    setPending(true);
    try {
      await turnMutation.mutateAsync({ turnId: turn.id, direction });
    } catch {
      // Keep the chip available for retry; history cards do not carry error prose.
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
        {hasEditedDocuments && receipt?.control !== "view_change" ? (
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
            {receipt?.control === "redo" ? t`Redo` : t`Undo`}
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <ul id={panelId} className="flex flex-col border-border-subtle border-t py-1">
          {documents.map((doc) => (
            <li key={doc.uri}>
              <DocumentRow document={doc} onOpenContextUri={openContextUri} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Full-width document row: hover washes the row, click opens the live file. */
function DocumentRow({
  document,
  onOpenContextUri,
}: {
  document: TurnEditDocument;
  onOpenContextUri: ((uri: string) => void) | null;
}) {
  const label = basenameOf(document);
  if (!onOpenContextUri) {
    return (
      <span className="flex min-h-6 items-center truncate px-3 pl-9 text-ink-strong">{label}</span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpenContextUri(document.uri)}
      className="focus-ring flex min-h-6 w-full items-center px-3 pl-9 text-left transition-colors hover:bg-surface-subtle"
    >
      <span className="min-w-0 truncate text-ink-strong">{label}</span>
    </button>
  );
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
