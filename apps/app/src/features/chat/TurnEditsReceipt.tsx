/**
 * TurnEditsReceipt — the compact per-turn receipt for what a turn edited.
 *
 * INVARIANT: record, not control panel — no draft affordance may be added here.
 * Review / Apply / Discard belong to the composer-attached DraftDock. Undo/Redo
 * is the only turn control. At rest, the receipt is one quiet borderless line.
 * The header names a single document when possible and carries durable word
 * deltas; expanding lists each document.
 *
 * Turn lineage owns Undo authority. Authorized trail detail owns durable row
 * evidence, navigation, and Restore state.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ReversalOutcome, Turn, TurnReceiptChip } from "@meridian/contracts/protocol";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ReversalDirection } from "@/client/api/reverse-api";
import type { ChangeTrailShell } from "@/client/change-trails";
import { useReverseTurnMutation } from "@/client/query/useReverseMutation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChangeViewRows } from "./ChangeViewRows";
import { useChatContextNavigation, useChatContextRoutability } from "./ChatContextNavigation";
import { type ConversationReveal, useConversationReveal } from "./conversation-reveal";
import { documentDisplayName } from "./document-display-name";
import { DraftStatsLabel } from "./draft-stats";
import { DocumentName } from "./tool-renderers";
import { useAuthorizedChangeTrailDetail } from "./useAuthorizedChangeTrailDetail";
import type { NavigateToTrailChange } from "./useChangeTrailNavigation";

export type TurnEditDocument = {
  documentId?: string;
  path: string;
  uri: string;
  scope: "live" | "draft";
};

export function hasTurnEditsReceiptDocuments(
  documents: TurnEditDocument[],
  changeTrail?: ChangeTrailShell,
): boolean {
  return (
    documents.some((document) => document.scope === "live") ||
    (changeTrail?.state === "settled" && changeTrail.documents.length > 0)
  );
}

export type TurnEditsReceiptProps = {
  threadId: string;
  turn: Turn;
  documents: TurnEditDocument[];
  receipt: TurnReceiptChip | null;
  changeTrail?: ChangeTrailShell;
  navigateToChange?: NavigateToTrailChange;
};

export function TurnEditsReceipt({
  threadId,
  turn,
  documents,
  receipt,
  changeTrail,
  navigateToChange,
}: TurnEditsReceiptProps) {
  const panelId = useId();
  const openContextUri = useChatContextNavigation();
  const canOpenContextUri = useChatContextRoutability();
  const [expanded, setExpanded] = useState(false);
  const reveal = useConversationReveal(threadId);
  const [activeReveal, setActiveReveal] = useState<ConversationReveal | null>(null);
  const [pending, setPending] = useState(false);
  const [commandRefusal, setCommandRefusal] = useState<ReversalOutcome["status"] | null>(null);
  const turnMutation = useReverseTurnMutation(threadId);

  const direction: ReversalDirection = receipt?.control === "redo" ? "redo" : "undo";
  const guardCopy = reversalRefusalCopy(commandRefusal) ?? undoGuardCopy(receipt);
  const liveDocuments = documents.filter((document) => document.scope === "live");
  const trailDocuments = changeTrail?.documents ?? [];
  // Asks the predicate about the full lineage, not the pre-filtered live subset.
  // Both callers must hand it the same thing or it owns the "is there a committed
  // receipt?" decision in name only — filtering first made its scope check dead
  // here while `AssistantTurn` still depends on it.
  const hasEditedDocuments = hasTurnEditsReceiptDocuments(documents, changeTrail);
  const headerDocuments = trailDocuments.length > 0 ? trailDocuments : liveDocuments;
  const headerDocumentCount = headerDocuments.length;
  const singleDocumentTitle =
    trailDocuments.length === 1
      ? trailDocuments[0]?.title
      : trailDocuments.length === 0 && liveDocuments.length === 1
        ? documentDisplayName(liveDocuments[0]?.uri ?? "").title
        : null;
  const wordStats =
    changeTrail &&
    (typeof changeTrail.wordsAdded === "number" || typeof changeTrail.wordsRemoved === "number")
      ? {
          kind: "words" as const,
          added: changeTrail.wordsAdded ?? 0,
          removed: changeTrail.wordsRemoved ?? 0,
        }
      : null;
  const undoUnavailable = receipt == null || receipt.control === "view_change";

  useEffect(() => {
    if (reveal?.turnId !== turn.id) return;
    setActiveReveal(reveal);
    setExpanded(true);
  }, [reveal, turn.id]);

  useEffect(() => {
    setCommandRefusal(null);
  }, [receipt?.control, receipt?.state]);

  if (!hasEditedDocuments) return null;

  async function reverseTurn() {
    if (pending || !receipt || receipt.control === "view_change") return;
    setPending(true);
    try {
      const outcome = await turnMutation.mutateAsync({ turnId: turn.id, direction });
      if (outcome.status !== "reversed" && outcome.status !== "reconciled") {
        setCommandRefusal(outcome.status);
        setExpanded(true);
      }
    } catch {
      // Keep the chip available for retry; history cards do not carry error prose.
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="mt-3 min-h-7 rounded-md text-caption text-ink-muted" data-turn-receipt>
      {/* The WHOLE header row is the expand/collapse target — hover washes the
            full width, wrapping around the Undo chip, which fences its own click. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the inner button is the keyboard-accessible toggle; the row onClick is a mouse convenience. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: same — mouse-convenience toggle over a semantic inner button. */}
      <div
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-7 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
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
          <span className="flex min-w-0 flex-1 items-baseline">
            <span className="min-w-0 truncate font-medium text-prose-foreground">
              {singleDocumentTitle
                ? documentTitleLabel(singleDocumentTitle)
                : documentCountLabel(headerDocumentCount)}
            </span>
            {wordStats ? (
              <span className="ml-2 shrink-0">
                {" "}
                <DraftStatsLabel stats={wordStats} />
              </span>
            ) : null}
          </span>
        </button>
        {undoUnavailable ? (
          <span
            className="shrink-0 rounded-full border border-border-subtle px-2 py-0.5 font-medium text-ink-muted"
            data-undo-unavailable
          >
            <Trans>Can't undo</Trans>
          </span>
        ) : (
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
        )}
      </div>
      {expanded ? (
        <div id={panelId} className="mt-1 border-border-subtle border-t py-1">
          {guardCopy ? (
            <p className="px-3 py-2 pl-9 text-ink-muted" data-undo-unavailable-reason>
              {guardCopy}
            </p>
          ) : null}
          {changeTrail && navigateToChange ? (
            <ChangeViewDetail
              threadId={threadId}
              shell={changeTrail}
              navigateToChange={navigateToChange}
              reveal={activeReveal}
              documents={liveDocuments}
              onOpenContextUri={openContextUri}
              canOpenContextUri={canOpenContextUri}
            />
          ) : (
            <ul className="flex flex-col">
              {liveDocuments.map((doc) => (
                <li key={doc.uri}>
                  <DocumentRow
                    document={doc}
                    onOpenContextUri={openContextUri}
                    canOpenContextUri={canOpenContextUri}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function reversalRefusalCopy(status: ReversalOutcome["status"] | null): string | null {
  if (status === "nothing_to_redo") {
    return t`Redo is no longer available because the manuscript changed.`;
  }
  if (status === "nothing_to_undo") return t`Undo is no longer available.`;
  if (status === "cant_undo_dependent") return t`Later edits build on this change.`;
  if (status === "expired") return t`This change is no longer reversible.`;
  if (status === "partial") return t`Only part of this change could be reversed.`;
  return null;
}

export function ChangeViewDetail({
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
  reveal: ReturnType<typeof useConversationReveal>;
  documents?: TurnEditDocument[];
  onOpenContextUri?: ((uri: string) => void) | null;
  canOpenContextUri?: ((uri: string) => boolean) | null;
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
    if ("unavailable" in document) {
      return (
        <p key={document.documentId} className="px-3 py-2 text-caption text-ink-muted">
          <Trans>This chapter is no longer available, so its change details can't be shown.</Trans>
        </p>
      );
    }
    if (document.changes.length === 0) return null;
    const liveDocument = documents.find(
      (candidate) => candidate.documentId === document.documentId,
    );

    return (
      <section key={document.documentId} aria-label={document.documentTitle}>
        {liveDocument ? (
          <DocumentRow
            document={liveDocument}
            onOpenContextUri={onOpenContextUri}
            canOpenContextUri={canOpenContextUri}
          />
        ) : (
          <span className="flex min-h-6 items-center truncate px-3 pl-9 text-prose-foreground">
            {document.documentTitle}
          </span>
        )}
        {document.anchorState === "deleted" ? (
          <p className="px-3 py-1 text-caption text-ink-muted">
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
  canOpenContextUri,
}: {
  document: TurnEditDocument;
  onOpenContextUri: ((uri: string) => void) | null;
  canOpenContextUri: ((uri: string) => boolean) | null;
}) {
  if (!onOpenContextUri || !canOpenContextUri?.(document.uri)) {
    return (
      <span className="flex min-h-6 items-center truncate px-3 pl-9 text-prose-foreground">
        <DocumentName path={document.uri} />
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpenContextUri(document.uri)}
      className="focus-ring flex min-h-6 w-full items-center px-3 pl-9 text-left transition-colors hover:bg-muted"
    >
      <DocumentName path={document.uri} />
    </button>
  );
}

function documentCountLabel(count: number) {
  return count === 1 ? <Trans>Edited 1 chapter</Trans> : <Trans>Edited {count} chapters</Trans>;
}

function documentTitleLabel(title: string) {
  return <Trans>Edited {title}</Trans>;
}
