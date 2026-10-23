/** Renders durable document and Work change receipts. */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type {
  TreeReversalLanding,
  Turn,
  TurnInverseSkip,
  TurnReceiptChip,
  TurnTreeLine,
} from "@meridian/contracts/protocol";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isReversibleWorkReceipt } from "@meridian/contracts/works";
import type { WorkReceipt } from "@meridian/thread-client";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { type ReversalDirection, successfulWorkReversals } from "@/client/api/reverse-api";
import type { ChangeTrailShell } from "@/client/change-trails";
import { useReverseTurnMutation } from "@/client/query/useReverseMutation";
import { applyRecentAvailability } from "@/client/recents";
import { Button } from "@/components/ui/button";
import { DraftStatsLabel } from "@/features/draft-review/draft-stats";
import { useOptionalAccountId } from "@/features/project/context/account-feature-context";
import { useProjectDocumentNavigationProjectId } from "@/features/project/context/open-project-document";
import { cn } from "@/lib/utils";
import { ChangeViewRows } from "./ChangeViewRows";
import { useChatContextNavigation, useChatContextRoutability } from "./ChatContextNavigation";
import { type ChangeRevealRequest, useChangeReveal } from "./conversation-reveal";
import { DocumentName } from "./DocumentName";
import {
  documentDisplayName,
  documentLocationName,
  moveDestinationName,
  type OwnerNames,
} from "./document-display-name";
import { useOwnerNames } from "./owner-names";
import {
  dependentChangeCopy,
  type ReversalRefusal,
  refusedReversalStatus,
  reversalRefusalCopy,
  skipCauseCopy,
  treeFaultLocation,
} from "./turn-receipt-copy";
import { useAuthorizedChangeTrailDetail } from "./useAuthorizedChangeTrailDetail";
import type { NavigateToTrailChange } from "./useChangeTrailNavigation";
import { workReceiptLine } from "./work-receipt-copy";

export type TurnEditDocument = {
  documentId: string;
  path: string;
  uri: string;
  scope: "live" | "draft";
  /** The turn moved or deleted it: the row says so instead of only naming it. */
  tree?: TurnTreeLine;
};

function hasTurnEditsReceiptDocuments(
  documents: TurnEditDocument[],
  changeTrail?: ChangeTrailShell,
): boolean {
  return (
    documents.length > 0 || (changeTrail?.state === "settled" && changeTrail.documents.length > 0)
  );
}

/** Whether this turn has a receipt to show at all: document edits, or a reversible Work mutation receipt. */
export function hasTurnEditsReceiptContent(
  documents: TurnEditDocument[],
  changeTrail: ChangeTrailShell | undefined,
  workReceipts: readonly WorkReceipt[],
): boolean {
  return (
    hasTurnEditsReceiptDocuments(documents, changeTrail) ||
    workReceipts.some(isReversibleWorkReceipt)
  );
}

export type TurnEditsReceiptProps = {
  threadId: string;
  turn: Turn;
  documents: TurnEditDocument[];
  receipt: TurnReceiptChip | null;
  /** Work receipts carried by this turn's tool results (`AssistantView.workReceipts`). */
  workReceipts?: readonly WorkReceipt[];
  changeTrail?: ChangeTrailShell;
  navigateToChange?: NavigateToTrailChange;
};

export function TurnEditsReceipt({
  threadId,
  turn,
  documents,
  receipt,
  workReceipts = [],
  changeTrail,
  navigateToChange,
}: TurnEditsReceiptProps) {
  const panelId = useId();
  const openContextUri = useChatContextNavigation();
  const canOpenContextUri = useChatContextRoutability();
  const [expanded, setExpanded] = useState(false);
  const changeReveal = useChangeReveal(threadId, turn.id);
  const [pending, setPending] = useState(false);
  const [draftOutcome, setDraftOutcome] = useState(false);
  // The parts the writer's last Undo or Redo left, with the command that left them.
  const [actionSkips, setActionSkips] = useState<{
    direction: ReversalDirection;
    skips: TurnInverseSkip[];
  } | null>(null);
  const [commandRefusal, setCommandRefusal] = useState<ReversalRefusal | null>(null);
  const [outcomeNotices, setOutcomeNotices] = useState<string[] | null>(null);
  const turnMutation = useReverseTurnMutation(threadId);
  const accountId = useOptionalAccountId();
  const projectId = useProjectDocumentNavigationProjectId();

  const direction: ReversalDirection = receipt?.control === "redo" ? "redo" : "undo";
  // A part the refusal line already names (a blocked or missing folder, or a document gone
  // again) isn't listed a second time.
  const skips = (actionSkips?.skips ?? receipt?.skips ?? []).filter(
    (skip) => !(skip.kind === "tree" && commandRefusal?.status === skip.cause),
  );
  const names = useOwnerNames();
  const guardCopy = commandRefusal
    ? reversalRefusalCopy(commandRefusal, names)
    : undoGuardCopy(receipt);
  const trailDocuments = changeTrail?.documents ?? [];
  const hasEditedDocuments = hasTurnEditsReceiptDocuments(documents, changeTrail);
  // Reversible Work mutation receipts are content in their own right: their
  // lines list as rows, and their presence is what keeps a Work-only turn's
  // Undo on screen.
  const reversibleWorkReceipts = workReceipts.filter(isReversibleWorkReceipt);
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
  const undoUnavailable = receipt == null || receipt.control === "view_change";

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

  useEffect(() => {
    if (receipt?.control !== "view_change") setCommandRefusal(null);
  }, [receipt?.control]);

  if (!hasTurnEditsReceiptContent(documents, changeTrail, workReceipts)) return null;

  async function reverseTurn() {
    if (pending || !receipt || receipt.control === "view_change") return;
    setPending(true);
    try {
      const outcome = await turnMutation.mutateAsync({ turnId: turn.id, direction });
      if (accountId && projectId) {
        const liveCreates = documents.filter(
          (document) =>
            document.scope === "live" &&
            outcome.documents.some(
              (result) =>
                result.documentId === document.documentId &&
                result.created &&
                result.status === "reversed" &&
                result.destination?.kind === "live",
            ),
        );
        if (direction === "undo") {
          applyRecentAvailability(accountId, {
            removed: liveCreates.map(({ documentId }) => ({ documentId, projectId })),
            updates: [],
          });
        } else {
          for (const document of liveCreates) {
            const uri =
              outcome.landings?.find((landing) => landing.documentId === document.documentId)
                ?.landedAt ?? document.uri;
            const parsed = parseContextUri(uri);
            if (!parsed.ok || !isProjectContextTreeScheme(parsed.value.scheme)) continue;
            applyRecentAvailability(accountId, {
              removed: [],
              updates: [
                {
                  documentId: document.documentId,
                  name: documentDisplayName(uri),
                  scheme: parsed.value.scheme,
                  path: `/${parsed.value.path}`,
                },
              ],
            });
          }
        }
      }
      setActionSkips({ direction, skips: outcome.skips ?? [] });
      const undoneInDraft =
        direction === "undo" &&
        outcome.documents.some(
          (document) => document.status === "reversed" && document.destination?.kind === "draft",
        );
      setDraftOutcome(undoneInDraft);
      if (undoneInDraft) setExpanded(true);
      const restored = successfulWorkReversals(outcome);
      const status =
        outcome.status === "partial" && outcome.acceptedParts
          ? null
          : refusedReversalStatus(outcome.status);
      // A Work-only turn has no document half, so its "nothing to undo" is a
      // fact about documents that were never part of the claim. With a Work
      // restored, repeating it would report a successful restore as refusal.
      const documentHalfEmpty =
        !hasEditedDocuments &&
        restored.length > 0 &&
        (status === "nothing_to_undo" || status === "nothing_to_redo");
      const refusal = status && !documentHalfEmpty ? status : null;
      setCommandRefusal(
        refusal
          ? { direction, status: refusal, at: treeFaultLocation(refusal, outcome.skips) }
          : null,
      );
      const notices = [
        ...(outcome.landings ?? []).map((landing) => treeLandingLine(landing, names)),
        ...restored.map(reversedWorkLine),
      ];
      setOutcomeNotices(notices.length ? [...new Set(notices)] : null);
      if (refusal || notices.length > 0 || outcome.skips?.length) setExpanded(true);
    } catch {
      // A rejected request is a refusal the writer never asked for: the command
      // is the only thing that can report it, so it says so here rather than
      // leaving the click looking like it worked.
      setCommandRefusal({ direction, status: "request_failed" });
      setExpanded(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-chat-interactive text-caption text-ink-muted"
      data-turn-receipt
    >
      {/* The WHOLE header row is the expand/collapse target — hover washes the
            full width, wrapping around the Undo chip, which fences its own click. */}
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
                ? documentCountLabel(
                    headerDocumentCount,
                    documents.some((document) => document.tree),
                  )
                : workCountLabel(reversibleWorkReceipts.length)}
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
            className="shrink-0 rounded-full border border-border-subtle px-[var(--chat-space-block)] py-0.5 font-medium text-ink-muted"
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
            {pending
              ? direction === "redo"
                ? t`Redoing…`
                : t`Undoing…`
              : direction === "redo"
                ? t`Redo`
                : t`Undo`}
          </Button>
        )}
      </div>
      {expanded ? (
        <div id={panelId} className="border-border-subtle border-t">
          {draftOutcome ? (
            <p
              className="px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)]"
              data-turn-draft-outcome
              role="status"
            >
              <Trans>Undone in your drafts. Apply them to change your manuscript.</Trans>
            </p>
          ) : null}
          {skips.length > 0 ? (
            <div
              className="px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)]"
              data-turn-skips
              role="status"
            >
              <p>{skipsHeading(skips.length, actionSkips?.direction ?? null, direction)}</p>
              <ul>
                {skips.map((skip, index) => (
                  <li key={`${skip.documentId}:${index}`}>
                    <SkipSubject skip={skip} />
                    <span className="ml-1">{skipCauseCopy(skip.cause)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {outcomeNotices?.map((notice) => (
            <p
              key={notice}
              className="px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)] pl-[var(--chat-geometry-receipt-indent)] text-prose-foreground"
              data-reversal-outcome
              role="status"
            >
              {notice}
            </p>
          ))}
          {guardCopy ? (
            <p
              className="px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)] pl-[var(--chat-geometry-receipt-indent)] text-ink-muted"
              data-undo-unavailable-reason
              role="status"
            >
              {guardCopy}
            </p>
          ) : null}
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
          {reversibleWorkReceipts.length > 0 ? (
            <ul className="flex flex-col">
              {reversibleWorkReceipts.map((workRow, index) => (
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

function undoGuardCopy(receipt: TurnReceiptChip | null): string | undefined {
  // Same fact as the refused-command copy, so it is the same sentence: a
  // receipt that rests on `cant_undo_dependent` and a command refused with it
  // are the writer's one situation.
  if (receipt?.state === "cant_undo_dependent") {
    return dependentChangeCopy();
  }
  if (receipt?.control === "view_change" || receipt == null) {
    return t`This change is no longer reversible.`;
  }
  return undefined;
}

/**
 * Full-width document row: hover washes the row, click opens the file. A document the turn
 * deleted is not a door: its old address may hold another document now.
 */
function DocumentRow({
  document,
  onOpenContextUri,
  canOpenContextUri,
}: {
  document: TurnEditDocument;
  onOpenContextUri: ((uri: string) => void) | null;
  canOpenContextUri: ((uri: string) => boolean) | null;
}) {
  const openable =
    document.tree?.op !== "delete" && onOpenContextUri && canOpenContextUri?.(document.uri);
  if (!openable) {
    return (
      <span className="flex min-h-6 items-center truncate px-[var(--chat-card-pad-x)] pl-[var(--chat-geometry-receipt-indent)] text-prose-foreground">
        <DocumentRowLabel document={document} />
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpenContextUri(document.uri)}
      className="focus-ring flex min-h-6 w-full items-center px-[var(--chat-card-pad-x)] pl-[var(--chat-geometry-receipt-indent)] text-left transition-colors hover:bg-muted"
    >
      <DocumentRowLabel document={document} />
    </button>
  );
}

/** A row's words: the document's name, or what the turn did to where it is. */
function DocumentRowLabel({ document }: { document: TurnEditDocument }) {
  const names = useOwnerNames();
  const tree = document.tree;
  if (tree?.op === "move") {
    const source = documentDisplayName(tree.from);
    const destination = moveDestinationName(tree.from, tree.to, names);
    return (
      <span className="min-w-0 truncate text-prose-foreground" data-turn-tree-line="move">
        <Trans>
          Moved {source} to {destination}
        </Trans>
      </span>
    );
  }
  if (tree?.op === "delete") {
    const name = documentDisplayName(tree.from);
    return (
      <span className="min-w-0 truncate text-prose-foreground" data-turn-tree-line="delete">
        <Trans>Deleted {name}</Trans>
      </span>
    );
  }
  // The whole row is the door here, so the name inside it stays inert.
  return <DocumentName path={document.uri} insideDoor />;
}

/** "Edited" while the turn only changed text; "Changed" once it moved or deleted a document. */
function documentCountLabel(count: number, tree: boolean) {
  if (tree)
    return count === 1 ? (
      <Trans>Changed 1 document</Trans>
    ) : (
      <Trans>Changed {count} documents</Trans>
    );
  return count === 1 ? <Trans>Edited 1 document</Trans> : <Trans>Edited {count} documents</Trans>;
}

/**
 * What the listed parts are: the ones the last Undo or Redo left as they were, or, before one,
 * the ones it would leave (a stopped turn's rolled-back parts, an applied draft).
 */
function skipsHeading(
  count: number,
  done: ReversalDirection | null,
  next: ReversalDirection,
): string {
  if (done === "redo")
    return plural(count, {
      one: "Redo left # part as it was",
      other: "Redo left # parts as they were",
    });
  if (done === "undo")
    return plural(count, {
      one: "Undo left # part as it was",
      other: "Undo left # parts as they were",
    });
  return next === "redo"
    ? plural(count, {
        one: "Redo leaves # part as it is",
        other: "Redo leaves # parts as they are",
      })
    : plural(count, {
        one: "Undo leaves # part as it is",
        other: "Undo leaves # parts as they are",
      });
}

/**
 * What a part that stayed was: its text excerpts, or the document a move or delete named. A
 * part stopped by a place (taken, its folder gone, moved again) names the whole place, so the
 * writer can find it.
 */
function SkipSubject({ skip }: { skip: TurnInverseSkip }) {
  const names = useOwnerNames();
  if (skip.kind === "tree") {
    const at = skip.at ?? skip.uri;
    return (
      <>
        {skip.cause === "ancestor_taken" ||
        skip.cause === "folder_missing" ||
        skip.cause === "superseded"
          ? documentLocationName(at, names)
          : documentDisplayName(at)}
      </>
    );
  }
  if (!skip.before && !skip.after) return <>{documentDisplayName(skip.uri)}</>;
  return (
    <>
      {skip.before ? `“${skip.before}”` : ""}
      {skip.before && skip.after ? " → " : ""}
      {skip.after ? `“${skip.after}”` : ""}
    </>
  );
}

/** The Work-only header: same counting grammar as documents, wearing the
 * writer's own word for the entity the turn changed. */
function workCountLabel(count: number) {
  return count === 1 ? <Trans>Changed 1 Work</Trans> : <Trans>Changed {count} Work</Trans>;
}

/** One receipt-style line per restored Work. The server names the Work when it
 * can; without a name the sentence stays factual instead of guessing one. */
function reversedWorkLine(work: { name: string; status: string }): string {
  return work.status === "redone"
    ? t`Redid change to Work ${work.name}.`
    : t`Undid change to Work ${work.name}.`;
}

/** Where a tree inverse actually committed when its recorded name was no longer free. */
function treeLandingLine(landing: TreeReversalLanding, names: OwnerNames): string {
  return landing.action === "restored"
    ? t`Restored as ${documentDisplayName(landing.landedAt)}.`
    : t`Moved to ${documentLocationName(landing.landedAt, names)}.`;
}
