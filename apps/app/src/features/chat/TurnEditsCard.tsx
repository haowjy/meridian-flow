/**
 * TurnEditsCard — the existing per-turn Changes view for what a turn edited.
 *
 * INVARIANT: record, not control panel — no draft affordance may be added here.
 * Review / Apply / Discard belong to the composer-attached DraftDock. The only
 * draft control this card carries is Undo. Expanded trail rows may carry the
 * recovery actions Restore and Delete again.
 *
 * Shape: a collapsed card at the end of every turn that edited documents
 * (created files count — they produce mutation rows like any edit). The header
 * carries only the document count; expanding lists each document.
 *
 * Turn lineage owns Undo authority. Authorized trail detail owns durable row
 * evidence, navigation, and forward-action identity.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Turn, TurnReceiptChip } from "@meridian/contracts/protocol";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ReversalDirection } from "@/client/api/reverse-api";
import type { ChangeTrailShell } from "@/client/change-trails";
import { useReverseTurnMutation } from "@/client/query/useReverseMutation";
import { Button } from "@/components/ui/button";
import { displayContextPath } from "@/lib/context-uri";
import { cn } from "@/lib/utils";
import { ChangeViewRows } from "./ChangeViewRows";
import { useChatContextNavigation } from "./ChatContextNavigation";
import { useConversationReveal } from "./conversation-reveal";
import { useAuthorizedChangeTrailDetail } from "./useAuthorizedChangeTrailDetail";
import type { NavigateToTrailChange } from "./useChangeTrailNavigation";

export type TurnEditDocument = {
  documentId?: string;
  path: string;
  uri: string;
  scope: "live" | "draft";
};

export type TurnEditsCardProps = {
  threadId: string;
  turn: Turn;
  documents: TurnEditDocument[];
  receipt: TurnReceiptChip | null;
  changeTrail?: ChangeTrailShell;
  navigateToChange?: NavigateToTrailChange;
};

export function TurnEditsCard({
  threadId,
  turn,
  documents,
  receipt,
  changeTrail,
  navigateToChange,
}: TurnEditsCardProps) {
  const panelId = useId();
  const openContextUri = useChatContextNavigation();
  const [expanded, setExpanded] = useState(false);
  const reveal = useConversationReveal(threadId);
  const [pending, setPending] = useState(false);
  const turnMutation = useReverseTurnMutation(threadId);

  const hasEditedDocuments = documents.length > 0 || Boolean(changeTrail);
  const direction: ReversalDirection = receipt?.control === "redo" ? "redo" : "undo";
  const guardCopy = undoGuardCopy(receipt);
  const undoUnavailable = receipt == null || receipt.control === "view_change";

  useEffect(() => {
    if (reveal?.turnId === turn.id) setExpanded(true);
  }, [reveal, turn.id]);

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
      className="mt-3 overflow-hidden rounded-lg border border-border bg-chat-interactive text-caption text-ink-muted"
      data-turn-edits-card
    >
      {/* The WHOLE header row is the expand/collapse target — hover washes the
            full width, wrapping around the Undo chip, which fences its own click. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the inner button is the keyboard-accessible toggle; the row onClick is a mouse convenience. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: same — mouse-convenience toggle over a semantic inner button. */}
      <div
        onClick={() => setExpanded((value) => !value)}
        className="flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors hover:bg-muted"
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
          <span className="min-w-0 flex-1 truncate font-medium text-prose-foreground">
            {documentCountLabel(Math.max(documents.length, changeTrail?.documentCount ?? 0))}
          </span>
        </button>
        {hasEditedDocuments && undoUnavailable ? (
          <span
            className="shrink-0 rounded-full border border-border-subtle px-2 py-0.5 font-medium text-ink-muted"
            data-undo-unavailable
          >
            <Trans>Can't undo</Trans>
          </span>
        ) : hasEditedDocuments ? (
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
      {guardCopy ? (
        <p className="px-3 pb-2 pl-9 text-ink-muted" data-undo-unavailable-reason>
          {guardCopy}
        </p>
      ) : null}
      {expanded ? (
        <div id={panelId} className="border-border-subtle border-t py-1">
          <ul className="flex flex-col">
            {documents.map((doc) => (
              <li key={doc.uri}>
                <DocumentRow document={doc} onOpenContextUri={openContextUri} />
              </li>
            ))}
          </ul>
          {changeTrail && navigateToChange ? (
            <ChangeViewDetail
              threadId={threadId}
              shell={changeTrail}
              navigateToChange={navigateToChange}
              reveal={reveal?.turnId === turn.id ? reveal : null}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ChangeViewDetail({
  threadId,
  shell,
  navigateToChange,
  reveal,
}: {
  threadId: string;
  shell: ChangeTrailShell;
  navigateToChange: NavigateToTrailChange;
  reveal: ReturnType<typeof useConversationReveal>;
}) {
  const { detail } = useAuthorizedChangeTrailDetail(threadId, shell, true);
  if (shell.state !== "settled") return null;
  if (detail.isError) {
    return (
      <div className="px-3 py-2 text-caption text-ink-muted">
        <p>
          <Trans>Couldn't load change details.</Trans>
        </p>
        <Button size="sm" onClick={() => void detail.refetch()}>
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  }
  return detail.data?.map((document) => {
    const writerTouchingChanges = document.changes?.filter(
      (change) => change.writerProtection != null,
    );
    const visibleChanges =
      reveal && document.changes
        ? [
            ...(writerTouchingChanges ?? []),
            ...document.changes.filter(
              (change) =>
                change.changeId === reveal.changeId &&
                !writerTouchingChanges?.some((candidate) => candidate.changeId === change.changeId),
            ),
          ]
        : writerTouchingChanges;
    if (!visibleChanges || visibleChanges.length === 0) return null;

    return (
      <section key={document.documentId} aria-label={document.documentTitle}>
        {document.unavailable ? (
          <p className="px-3 py-1 text-caption text-ink-muted">
            <Trans>
              This chapter is no longer available. Copy any saved text you want to keep.
            </Trans>
          </p>
        ) : null}
        <ChangeViewRows
          threadId={threadId}
          trailId={shell.trailId}
          documentId={document.documentId}
          changes={visibleChanges}
          navigateToChange={navigateToChange}
          anchorUnavailable={document.unavailable}
          reveal={reveal}
        />
      </section>
    );
  });
}

function undoGuardCopy(receipt: TurnReceiptChip | null): string | undefined {
  if (receipt?.state === "cant_undo_dependent") {
    return t`Later edits build on this change.`;
  }
  if (receipt?.control === "view_change" || receipt == null) {
    return t`This change is too old to undo.`;
  }
  return undefined;
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
      <span className="flex min-h-6 items-center truncate px-3 pl-9 text-prose-foreground">
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpenContextUri(document.uri)}
      className="focus-ring flex min-h-6 w-full items-center px-3 pl-9 text-left transition-colors hover:bg-muted"
    >
      <span className="min-w-0 truncate text-prose-foreground">{label}</span>
    </button>
  );
}

function documentCountLabel(count: number) {
  return count === 1 ? (
    <Trans>AI edited 1 chapter</Trans>
  ) : (
    <Trans>AI edited {count} chapters</Trans>
  );
}

function basenameOf(document: TurnEditDocument): string {
  const display = displayContextPath(document.uri, document.path);
  const trimmed = display.replace(/\/+$/, "");
  const parts = trimmed.split("/").filter(Boolean);
  return parts.at(-1) ?? trimmed;
}
