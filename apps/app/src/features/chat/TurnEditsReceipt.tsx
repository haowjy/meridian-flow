/** Renders durable document and Work change receipts. The writer reverses a change in the draft or the editor, never here. */
import { Trans } from "@lingui/react/macro";
import type { Turn } from "@meridian/contracts/protocol";
import type { WorkReceipt } from "@meridian/thread-client";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ChangeTrailShell } from "@/client/change-trails";
import { Button } from "@/components/ui/button";
import { DraftStatsLabel } from "@/features/draft-review/draft-stats";
import { cn } from "@/lib/utils";
import { ChangeViewRows } from "./ChangeViewRows";
import { useChatContextNavigation, useChatContextRoutability } from "./ChatContextNavigation";
import { type ChangeRevealRequest, useChangeReveal } from "./conversation-reveal";
import { DocumentName } from "./DocumentName";
import { useAuthorizedChangeTrailDetail } from "./useAuthorizedChangeTrailDetail";
import type { NavigateToTrailChange } from "./useChangeTrailNavigation";
import { workReceiptLine } from "./work-receipt-copy";

export type TurnEditDocument = {
  documentId: string;
  path: string;
  uri: string;
  scope: "live" | "draft";
  invisibleWrites?: true;
};

function hasTurnEditsReceiptDocuments(
  documents: TurnEditDocument[],
  changeTrail?: ChangeTrailShell,
): boolean {
  return (
    documents.length > 0 || (changeTrail?.state === "settled" && changeTrail.documents.length > 0)
  );
}

/** Whether this turn has a receipt to show at all: document edits, or a Work mutation receipt. */
export function hasTurnEditsReceiptContent(
  documents: TurnEditDocument[],
  changeTrail: ChangeTrailShell | undefined,
  workReceipts: readonly WorkReceipt[],
): boolean {
  return (
    hasTurnEditsReceiptDocuments(documents, changeTrail) ||
    workReceipts.some((receipt) => receipt.changed)
  );
}

export type TurnEditsReceiptProps = {
  threadId: string;
  turn: Turn;
  documents: TurnEditDocument[];
  /** Work receipts carried by this turn's tool results (`turnWorkReceipts`). */
  workReceipts?: readonly WorkReceipt[];
  changeTrail?: ChangeTrailShell;
  navigateToChange?: NavigateToTrailChange;
};

export function TurnEditsReceipt({
  threadId,
  turn,
  documents,
  workReceipts = [],
  changeTrail,
  navigateToChange,
}: TurnEditsReceiptProps) {
  const panelId = useId();
  const openContextUri = useChatContextNavigation();
  const canOpenContextUri = useChatContextRoutability();
  const [expanded, setExpanded] = useState(false);
  const changeReveal = useChangeReveal(threadId, turn.id);

  const trailDocuments = changeTrail?.documents ?? [];
  const hasEditedDocuments = hasTurnEditsReceiptDocuments(documents, changeTrail);
  // Work mutation receipts are content in their own right: their lines list as
  // rows, and a Work-only turn still gets a card.
  const changedWorkReceipts = workReceipts.filter((receipt) => receipt.changed);
  // Chrome counts, never names. A document name here would sit inside the
  // disclosure toggle, competing for the click at the moment the writer is
  // reaching to open it — and the names it would compete with are the ones in
  // the expanded rows below, which already navigate.
  const trailDocumentIds = new Set(trailDocuments.map((document) => document.documentId));
  const headerDocumentCount = new Set([
    ...trailDocumentIds,
    ...documents.map((document) => document.documentId),
  ]).size;
  const showTrailDetail =
    changeTrail?.state === "settled" && trailDocuments.length > 0 && navigateToChange;
  const documentRows = showTrailDetail
    ? documents.filter((document) => !trailDocumentIds.has(document.documentId))
    : documents;
  const wordStats =
    changeTrail &&
    (typeof changeTrail.wordsAdded === "number" || typeof changeTrail.wordsRemoved === "number")
      ? {
          kind: "words" as const,
          added: changeTrail.wordsAdded ?? 0,
          removed: changeTrail.wordsRemoved ?? 0,
        }
      : null;

  // The change stage of a conversation reveal — only a reveal naming a change
  // row inside THIS turn reaches here. The request is never copied into local
  // state: display without the lifecycle is what let a request outlive
  // everything that could finish it.
  useEffect(() => {
    if (!changeReveal) return;
    // Change rows are durable trail evidence; without an authorized trail this
    // receipt has no row to reveal, and the writer stays on the turn.
    if (
      !hasEditedDocuments ||
      changeTrail?.state !== "settled" ||
      changeTrail.documents.length === 0 ||
      !navigateToChange
    ) {
      changeReveal.unavailable();
      return;
    }
    setExpanded(true);
  }, [changeReveal, changeTrail, hasEditedDocuments, navigateToChange]);

  if (!hasTurnEditsReceiptContent(documents, changeTrail, workReceipts)) return null;

  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-chat-interactive text-caption text-ink-muted"
      data-turn-receipt
    >
      {/* The WHOLE header row is the expand/collapse target — hover washes the full width. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the inner button is the keyboard-accessible toggle; the row onClick is a mouse convenience. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: same — mouse-convenience toggle over a semantic inner button. */}
      <div
        onClick={() => setExpanded((value) => !value)}
        className="flex cursor-pointer items-center gap-[var(--chat-space-inline)] px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)] transition-colors hover:bg-muted"
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
          className="focus-ring -mx-1 flex min-w-0 flex-1 items-center gap-[var(--chat-space-inline)] rounded-md px-1 text-left"
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
          <span className="flex min-w-0 flex-1 items-baseline">
            <span className="min-w-0 truncate font-medium text-prose-foreground">
              {headerDocumentCount > 0
                ? documentCountLabel(headerDocumentCount)
                : workCountLabel(changedWorkReceipts.length)}
            </span>
            {wordStats ? (
              <span className="ml-2 shrink-0">
                {" "}
                <DraftStatsLabel stats={wordStats} />
              </span>
            ) : null}
          </span>
        </button>
      </div>
      {expanded ? (
        <div id={panelId} className="border-border-subtle border-t">
          {showTrailDetail && changeTrail && navigateToChange ? (
            <ChangeViewDetail
              threadId={threadId}
              shell={changeTrail}
              navigateToChange={navigateToChange}
              reveal={changeReveal}
              documents={documents}
              onOpenContextUri={openContextUri}
              canOpenContextUri={canOpenContextUri}
            />
          ) : null}
          {documentRows.length > 0 ? (
            <ul className="flex flex-col">
              {documentRows.map((doc) => (
                <li key={doc.uri}>
                  <DocumentRow
                    document={doc}
                    onOpenContextUri={openContextUri}
                    canOpenContextUri={canOpenContextUri}
                  />
                </li>
              ))}
            </ul>
          ) : null}
          {changedWorkReceipts.length > 0 ? (
            <ul className="flex flex-col">
              {changedWorkReceipts.map((workRow, index) => (
                <li key={`${index}:${workRow.operation}:${workRow.workId}`}>
                  <span className="flex min-h-6 items-center truncate px-[var(--chat-card-pad-x)] pl-[var(--chat-geometry-receipt-indent)] text-prose-foreground">
                    {workReceiptLine(workRow)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Authorized durable evidence for one settled trail, and the change stage's
 * settle point. Private: the receipt is the only surface that owns it. */
function ChangeViewDetail({
  threadId,
  shell,
  navigateToChange,
  reveal,
  documents = [],
  onOpenContextUri = null,
  canOpenContextUri = null,
}: {
  threadId: string;
  shell: ChangeTrailShell;
  navigateToChange: NavigateToTrailChange;
  reveal: ChangeRevealRequest | null;
  documents?: TurnEditDocument[];
  onOpenContextUri?: ((uri: string) => void) | null;
  canOpenContextUri?: ((uri: string) => boolean) | null;
}) {
  const { detail } = useAuthorizedChangeTrailDetail(threadId, shell, true);

  // Where the change stage settles: a row can be revealed only if the loaded
  // evidence carries it. A failed request or a trail that no longer holds the
  // change both leave the writer on the turn instead of waiting forever.
  useEffect(() => {
    if (!reveal) return;
    if (detail.isError) {
      reveal.unavailable();
      return;
    }
    if (!detail.data) return;
    const rowExists = detail.data.some(
      (document) =>
        !("unavailable" in document) &&
        document.changes.some((change) => change.changeId === reveal.changeId),
    );
    if (!rowExists) reveal.unavailable();
  }, [detail.data, detail.isError, reveal]);

  if (shell.state !== "settled") return null;
  if (detail.isError) {
    return (
      <div className="px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)] text-caption text-ink-muted">
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
    if ("unavailable" in document) {
      return (
        <p
          key={document.documentId}
          className="px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)] text-caption text-ink-muted"
        >
          <Trans>This chapter is no longer available, so its change details can't be shown.</Trans>
        </p>
      );
    }
    if (document.changes.length === 0) return null;
    const editedDocument = documents.find(
      (candidate) => candidate.documentId === document.documentId,
    );

    return (
      <section key={document.documentId} aria-label={document.documentTitle}>
        {editedDocument ? (
          <DocumentRow
            document={editedDocument}
            onOpenContextUri={onOpenContextUri}
            canOpenContextUri={canOpenContextUri}
          />
        ) : (
          <span className="flex min-h-6 items-center truncate px-[var(--chat-card-pad-x)] pl-[var(--chat-geometry-receipt-indent)] text-prose-foreground">
            {document.documentTitle}
          </span>
        )}
        {document.anchorState === "deleted" ? (
          <p className="px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)] text-caption text-ink-muted">
            <Trans>
              This chapter is no longer available. Copy any saved text you want to keep.
            </Trans>
          </p>
        ) : null}
        <ChangeViewRows
          documentId={document.documentId}
          changes={document.changes}
          navigateToChange={navigateToChange}
          anchorUnavailable={document.anchorState === "deleted"}
          reveal={reveal}
        />
      </section>
    );
  });
}

/** Full-width document row: hover washes the row, click opens the file. */
function DocumentRow({
  document,
  onOpenContextUri,
  canOpenContextUri,
}: {
  document: TurnEditDocument;
  onOpenContextUri: ((uri: string) => void) | null;
  canOpenContextUri: ((uri: string) => boolean) | null;
}) {
  const note = document.invisibleWrites ? (
    <p className="px-[var(--chat-card-pad-x)] pb-1 pl-[var(--chat-geometry-receipt-indent)] text-ink-muted">
      <Trans>Some of this reply's words went into text you discarded.</Trans>
    </p>
  ) : null;
  if (!onOpenContextUri || !canOpenContextUri?.(document.uri)) {
    return (
      <>
        <span className="flex min-h-6 items-center truncate px-[var(--chat-card-pad-x)] pl-[var(--chat-geometry-receipt-indent)] text-prose-foreground">
          <DocumentName path={document.uri} insideDoor />
        </span>
        {note}
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => onOpenContextUri(document.uri)}
        className="focus-ring flex min-h-6 w-full items-center px-[var(--chat-card-pad-x)] pl-[var(--chat-geometry-receipt-indent)] text-left transition-colors hover:bg-muted"
      >
        {/* The whole row is the door here, so the name inside it stays inert. */}
        <DocumentName path={document.uri} insideDoor />
      </button>
      {note}
    </>
  );
}

function documentCountLabel(count: number) {
  return count === 1 ? <Trans>Edited 1 document</Trans> : <Trans>Edited {count} documents</Trans>;
}

/** The Work-only header: same counting grammar as documents, wearing the
 * writer's own word for the entity the turn changed. */
function workCountLabel(count: number) {
  return count === 1 ? <Trans>Changed 1 Work</Trans> : <Trans>Changed {count} Work</Trans>;
}
