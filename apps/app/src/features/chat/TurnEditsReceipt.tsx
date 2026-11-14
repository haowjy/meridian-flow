/** Renders durable document and Work change receipts. */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type {
  TreeReversalLanding,
  Turn,
  TurnInverseSkip,
  TurnLiveLineageDocumentItem,
  TurnReceiptChip,
} from "@meridian/contracts/protocol";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isReversibleWorkReceipt } from "@meridian/contracts/works";
import type { WorkReceipt } from "@meridian/thread-client";
import { useEffect, useId, useState } from "react";
import { type ReversalDirection, successfulWorkReversals } from "@/client/api/reverse-api";
import { useReverseTurnMutation } from "@/client/query/useReverseMutation";
import { applyRecentAvailability } from "@/client/recents";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { FoldToggle } from "@/components/ui/fold-toggle";
import { MIDDLE_BUTTON } from "@/core/editor/links";
import { useOptionalAccountId } from "@/features/project/context/account-feature-context";
import { useReferenceDrag } from "@/features/project/context/entry-drag/reference-source";
import { useProjectDocumentNavigationProjectId } from "@/features/project/context/open-project-document";
import {
  type CanOpenContextUri,
  type OpenContextUri,
  useChatContextNavigation,
  useChatContextRoutability,
} from "./ChatContextNavigation";
import { DocumentName } from "./DocumentName";
import {
  describeModelMove,
  documentDisplayName,
  documentLocationName,
  folderDisplayName,
  type OwnerNames,
} from "./document-display-name";
import { useOwnerNames } from "./owner-names";
import {
  type ReversalRefusal,
  refusedReversalStatus,
  reversalRefusalCopy,
  skipCauseCopy,
  treeFaultLocation,
} from "./turn-receipt-copy";
import { workReceiptLine } from "./work-receipt-copy";

/** One document a turn edited: where the edit landed (a draft names its Work), and what it did to the document's place. */
export type TurnEditDocument = TurnLiveLineageDocumentItem;

/** Whether this turn has a receipt to show at all: document edits, or a reversible Work mutation receipt. */
export function hasTurnEditsReceiptContent(
  documents: TurnEditDocument[],
  workReceipts: readonly WorkReceipt[],
): boolean {
  return documents.length > 0 || workReceipts.some(isReversibleWorkReceipt);
}

export type TurnEditsReceiptProps = {
  threadId: string;
  turn: Turn;
  documents: TurnEditDocument[];
  receipt: TurnReceiptChip | null;
  /** Work receipts carried by this turn's tool results (`AssistantView.workReceipts`). */
  workReceipts?: readonly WorkReceipt[];
};

export function TurnEditsReceipt({
  threadId,
  turn,
  documents,
  receipt,
  workReceipts = [],
}: TurnEditsReceiptProps) {
  const panelId = useId();
  const openContextUri = useChatContextNavigation();
  const canOpenContextUri = useChatContextRoutability();
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
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
    : undoGuardCopy(receipt, skips.length > 0);
  const hasEditedDocuments = documents.length > 0;
  // Reversible Work mutation receipts are content in their own right: their
  // lines list as rows, and their presence is what keeps a Work-only turn's
  // Undo on screen.
  const reversibleWorkReceipts = workReceipts.filter(isReversibleWorkReceipt);
  const undoUnavailable = receipt == null || receipt.control === "view_change";

  useEffect(() => {
    if (receipt?.control !== "view_change") setCommandRefusal(null);
  }, [receipt?.control]);

  if (!hasTurnEditsReceiptContent(documents, workReceipts)) return null;

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
      className="overflow-hidden rounded-lg border border-border bg-card text-xs text-muted-foreground"
      data-turn-receipt
    >
      {/* The WHOLE header row is the expand/collapse target, around the Undo chip, which
            fences its own click. No hover fill, as on every fold. A strip row with the box's
            border, whether Undo or "Can't undo" shows. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the inner button is the keyboard-accessible toggle; the row onClick is a mouse convenience. slop-lint: allow suppression the reason is stated in this comment */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: same — mouse-convenience toggle over a semantic inner button. slop-lint: allow suppression the reason is stated in this comment */}
      <div
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-[calc(var(--strip-row)-2px)] cursor-pointer items-center gap-[var(--chat-space-inline)] px-[var(--chat-card-pad-x)] py-1"
      >
        <FoldToggle
          open={expanded}
          onToggle={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
          aria-controls={panelId}
          inline
          className="-mx-1 flex-1 px-1 coarse:min-h-11"
        >
          <span className="flex min-w-0 flex-1 items-baseline">
            <span className="min-w-0 truncate font-medium text-foreground">
              {hasEditedDocuments
                ? documentCountLabel(documents)
                : workCountLabel(reversibleWorkReceipts.length)}
            </span>
          </span>
        </FoldToggle>
        {undoUnavailable ? (
          <Chip kind="label" className="shrink-0" data-undo-unavailable>
            <Trans>Can't undo</Trans>
          </Chip>
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
          {skips.length > 0 ? (
            <div
              className="px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)]"
              data-turn-skips
              role="status"
            >
              <p>
                {undoUnavailable && !actionSkips
                  ? t`What happened to each part`
                  : skipsHeading(skips.length, actionSkips?.direction ?? null, direction)}
              </p>
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
              className="px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)] pl-[var(--chat-geometry-receipt-indent)] text-foreground"
              data-reversal-outcome
              role="status"
            >
              {notice}
            </p>
          ))}
          {guardCopy ? (
            <p
              className="px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)] pl-[var(--chat-geometry-receipt-indent)] text-muted-foreground"
              data-undo-unavailable-reason
              role="status"
            >
              {guardCopy}
            </p>
          ) : null}
          {documents.length > 0 ? (
            <ul className="flex flex-col">
              {documents.map((doc) => (
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
                  <span className="flex min-h-6 items-center truncate px-[var(--chat-card-pad-x)] pl-[var(--chat-geometry-receipt-indent)] text-foreground">
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

function undoGuardCopy(receipt: TurnReceiptChip | null, partsListed: boolean): string | undefined {
  // Listed parts already say why nothing can be undone, part by part.
  if ((receipt?.control === "view_change" || receipt == null) && !partsListed) {
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
  onOpenContextUri: OpenContextUri | null;
  canOpenContextUri: CanOpenContextUri | null;
}) {
  const drag = useDocumentRowDrag(document);
  // A folder has no document to open or drag: its row names where it is.
  if (document.folder)
    return (
      <span className="flex min-h-6 items-center truncate px-[var(--chat-card-pad-x)] pl-[var(--chat-geometry-receipt-indent)] text-foreground">
        {folderDisplayName(document.uri)}
      </span>
    );
  const openable =
    document.tree?.op !== "delete" && onOpenContextUri && canOpenContextUri?.(document.uri);
  if (!openable) {
    return (
      <span
        {...drag}
        className="flex min-h-6 items-center truncate px-[var(--chat-card-pad-x)] pl-[var(--chat-geometry-receipt-indent)] text-foreground"
      >
        <DocumentRowLabel document={document} />
      </span>
    );
  }
  return (
    <button
      type="button"
      {...drag}
      onClick={() => onOpenContextUri(document.uri)}
      onAuxClick={(event) => {
        if (event.button === MIDDLE_BUTTON) onOpenContextUri(document.uri);
      }}
      className="focus-ring flex min-h-6 w-full items-center px-[var(--chat-card-pad-x)] pl-[var(--chat-geometry-receipt-indent)] text-left transition-colors hover:bg-ink-fill"
    >
      <DocumentRowLabel document={document} />
    </button>
  );
}

/**
 * Dragging a row drags the document it represents, never the receipt or the pathname the turn
 * wrote. A draft row copies the draft of the Work the turn wrote in, even after the chat moved
 * to another Work; a document the turn deleted names nothing a drop could act on.
 */
function useDocumentRowDrag(document: TurnEditDocument) {
  return useReferenceDrag(
    document.tree?.op !== "delete" && !document.folder
      ? {
          ref: { kind: "file", id: document.documentId },
          name: documentDisplayName(document.uri),
          view:
            document.scope === "draft"
              ? { kind: "draft", owner: document.owner }
              : { kind: "live" },
        }
      : null,
  );
}

/** A row's words: the document's name, or what the turn did to where it is. */
function DocumentRowLabel({ document }: { document: TurnEditDocument }) {
  const names = useOwnerNames();
  const tree = document.tree;
  if (tree?.op === "move") {
    const source = documentDisplayName(tree.from);
    const { kind, place } = describeModelMove(tree.from, tree.to, names);
    if (kind === "reorder")
      return (
        <span className="min-w-0 truncate text-foreground" data-turn-tree-line="move">
          <Trans>Changed the position of {source}</Trans>
        </span>
      );
    return (
      <span className="min-w-0 truncate text-foreground" data-turn-tree-line="move">
        <Trans>
          Moved {source} to {place}
        </Trans>
      </span>
    );
  }
  if (tree?.op === "copy") {
    const source = documentDisplayName(tree.from);
    const { place } = describeModelMove(tree.from, tree.to, names);
    return (
      <span className="min-w-0 truncate text-foreground" data-turn-tree-line="copy">
        <Trans>
          Copied {source} to {place}
        </Trans>
      </span>
    );
  }
  if (tree?.op === "delete") {
    const name = documentDisplayName(tree.from);
    return (
      <span className="min-w-0 truncate text-foreground" data-turn-tree-line="delete">
        <Trans>Deleted {name}</Trans>
      </span>
    );
  }
  // The whole row is the door here, so the name inside it stays inert.
  return <DocumentName path={document.uri} insideDoor />;
}

/**
 * "Drafted" when every change went into a draft, so the manuscript is as it was until the writer
 * applies it; else "Edited" while the turn only changed text, "Changed" once it moved, deleted or
 * made something or wrote both drafts and the manuscript. Documents and folders are counted
 * apart, so a reorganisation says it touched folders too. The part lines say what became of each.
 * It counts, never names: a name inside the toggle would compete for the click with the
 * expanded rows, which already open each document.
 */
function documentCountLabel(documents: readonly TurnEditDocument[]): string {
  const counted = (folder: boolean) =>
    new Set(
      documents
        .filter((document) => !!document.folder === folder)
        .map(({ documentId }) => documentId),
    ).size;
  const files = plural(counted(false), { one: "# document", other: "# documents" });
  const folders = plural(counted(true), { one: "# folder", other: "# folders" });
  const what =
    counted(true) === 0 ? files : counted(false) === 0 ? folders : t`${files} and ${folders}`;
  if (documents.every((document) => document.scope === "draft")) return t`Drafted ${what}`;
  if (documents.some((document) => document.scope === "draft" || document.tree || document.folder))
    return t`Changed ${what}`;
  return t`Edited ${what}`;
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
