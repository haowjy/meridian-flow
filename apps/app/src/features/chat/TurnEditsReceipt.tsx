/** Renders durable document and Work change receipts. */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { agentsLocationOf } from "@meridian/contracts/agents";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type {
  TreeReversalLanding,
  Turn,
  TurnDraftState,
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
import { FoldToggle } from "@/components/ui/fold-toggle";
import { MIDDLE_BUTTON } from "@/core/editor/links";
import { AgentFileSave } from "@/features/agents/PackageSave";
import { packageFolderOf, packageLabel } from "@/features/agents/package-save";
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

  const drafts = receipt?.drafts;
  const direction: ReversalDirection = receipt?.control === "redo" ? "redo" : "undo";
  // A part the refusal line already names (a blocked or missing folder, or a document gone
  // again) isn't listed a second time, nor is a drafted document's apply or discard: its row
  // says what became of it.
  const skips = (actionSkips?.skips ?? receipt?.skips ?? []).filter(
    (skip) =>
      !(skip.kind === "tree" && commandRefusal?.status === skip.cause) &&
      !(drafts?.[skip.documentId] && (skip.cause === "applied" || skip.cause === "discarded")),
  );
  const names = useOwnerNames();
  const guardCopy = commandRefusal ? reversalRefusalCopy(commandRefusal, names) : undefined;
  const hasEditedDocuments = documents.length > 0;
  // Reversible Work mutation receipts are content in their own right: their
  // lines list as rows, and their presence is what keeps a Work-only turn's
  // Undo on screen.
  const reversibleWorkReceipts = workReceipts.filter(isReversibleWorkReceipt);
  const reversible = receipt != null && receipt.control !== "view_change";

  useEffect(() => {
    if (receipt?.control !== "view_change") setCommandRefusal(null);
  }, [receipt?.control]);

  if (!hasTurnEditsReceiptContent(documents, workReceipts)) return null;

  async function reverseTurn() {
    if (pending || !reversible) return;
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
          ? {
              direction,
              status: refusal,
              at: treeFaultLocation(refusal, outcome.skips),
              denial: outcome.denial,
            }
          : null,
      );
      const notices = [
        ...(outcome.landings ?? []).map((landing) => treeLandingLine(landing, names)),
        ...restored.map((work) => reversedWorkLine(work, names)),
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
        className="flex min-h-[calc(var(--strip-row)-2px)] cursor-pointer flex-wrap items-center gap-x-[var(--chat-space-inline)] px-[var(--chat-card-pad-x)] py-1"
      >
        <FoldToggle
          open={expanded}
          onToggle={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
          aria-controls={panelId}
          inline
          multiline
          className="-mx-1 min-w-[min(100%,10rem)] flex-1 px-1 coarse:min-h-11"
        >
          <span className="min-w-0 flex-1 font-medium text-foreground">
            {hasEditedDocuments
              ? documentCountLabel(documents, drafts)
              : workCountLabel(reversibleWorkReceipts.length)}
          </span>
        </FoldToggle>
        {reversible ? (
          <Button
            type="button"
            variant="quiet"
            size="meta"
            onClick={(event) => {
              event.stopPropagation();
              void reverseTurn();
            }}
            disabled={pending}
            className="ml-auto shrink-0 text-jade-text"
          >
            {pending
              ? direction === "redo"
                ? t`Redoing…`
                : t`Undoing…`
              : direction === "redo"
                ? t`Redo`
                : t`Undo`}
          </Button>
        ) : null}
      </div>
      {projectId ? (
        <AgentPackagesSaveLines projectId={projectId} documents={documents} drafts={drafts} />
      ) : null}
      {expanded ? (
        <div id={panelId} className="border-border-subtle border-t">
          {skips.length > 0 ? (
            <div
              className="px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)] text-muted-foreground"
              data-turn-skips
              role="status"
            >
              <p>
                {!reversible && !actionSkips
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
              data-reversal-refusal
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
                    draft={
                      doc.scope === "draft" && !doc.folder ? drafts?.[doc.documentId] : undefined
                    }
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
                    {workReceiptLine(workRow, names)}
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

/**
 * The Save state of each Agent package the turn's writes landed in (a live write, an applied
 * draft), on its own line under the header while it has one: the same chip and Save the Agents
 * tab shows.
 */
function AgentPackagesSaveLines({
  projectId,
  documents,
  drafts,
}: {
  projectId: string;
  documents: readonly TurnEditDocument[];
  drafts: TurnReceiptChip["drafts"] | undefined;
}) {
  const seen = new Set<string>();
  const files = documents.flatMap((document) => {
    if (document.folder) return [];
    if (document.scope === "draft" && drafts?.[document.documentId] !== "applied") return [];
    const parsed = parseContextUri(document.uri);
    if (!parsed.ok) return [];
    const { scheme, path } = parsed.value;
    const at = agentsLocationOf(scheme, path);
    if (!at) return [];
    const pkg = { level: at.level, folder: packageFolderOf(at.path) };
    const key = `${pkg.level}:${pkg.folder}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ key, scheme, path, label: packageLabel(pkg) }];
  });
  return files.map((file) => (
    <div
      key={file.key}
      className="flex items-center px-[var(--chat-card-pad-x)] pb-1 empty:hidden"
      data-turn-agent-package
    >
      <AgentFileSave
        projectId={projectId}
        scheme={file.scheme}
        path={file.path}
        before={<span className="min-w-0 truncate text-foreground">{file.label}</span>}
      />
    </div>
  ));
}

/**
 * Full-width document row: hover washes the row, click opens the file. A document the turn
 * deleted is not a door: its old address may hold another document now.
 */
function DocumentRow({
  document,
  draft,
  onOpenContextUri,
  canOpenContextUri,
}: {
  document: TurnEditDocument;
  /** What became of the document's draft text, when the turn drafted it. */
  draft: TurnDraftState | undefined;
  onOpenContextUri: OpenContextUri | null;
  canOpenContextUri: CanOpenContextUri | null;
}) {
  const drag = useDocumentRowDrag(document);
  // A folder has no document to open or drag: its row names where it is.
  if (document.folder && !document.tree)
    return (
      <span className="flex min-h-6 items-center truncate px-[var(--chat-card-pad-x)] pl-[var(--chat-geometry-receipt-indent)] text-foreground">
        {folderDisplayName(document.uri)}
      </span>
    );
  const openable =
    !document.folder &&
    document.tree?.op !== "delete" &&
    onOpenContextUri &&
    canOpenContextUri?.(document.uri);
  if (!openable) {
    return (
      <span
        {...drag}
        className="flex min-h-6 items-center truncate px-[var(--chat-card-pad-x)] pl-[var(--chat-geometry-receipt-indent)] text-foreground"
      >
        <DocumentRowLabel document={document} />
        <DraftStateWord state={draft} />
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
      <DraftStateWord state={draft} />
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

/** What a drafted document's text stands at now; one still waiting needs no word. */
function DraftStateWord({ state }: { state: TurnDraftState | undefined }) {
  if (state !== "applied" && state !== "discarded") return null;
  return (
    <span className="ml-auto shrink-0 pl-2 text-muted-foreground" data-draft-state={state}>
      {state === "applied" ? t`Applied` : t`Discarded`}
    </span>
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
 * "Drafted" when every change went into a draft and some still wait; "Applied" or "Discarded"
 * once every one of them has had that outcome; the mix said in counts when they differ. Else
 * "Edited" while the turn only changed text, "Changed" once it moved, deleted or made something
 * or wrote both drafts and the manuscript. Documents and folders are counted apart, so a
 * reorganisation says it touched folders too. It counts, never names: a name inside the toggle
 * would compete for the click with the expanded rows, which already open each document.
 */
function documentCountLabel(
  documents: readonly TurnEditDocument[],
  drafts: TurnReceiptChip["drafts"],
): string {
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
  if (documents.every((document) => document.scope === "draft")) {
    const states = new Map<string, TurnDraftState | undefined>(
      documents
        .filter((document) => !document.folder)
        .map(({ documentId }) => [documentId, drafts?.[documentId]]),
    );
    const count = (state: TurnDraftState) =>
      [...states.values()].filter((value) => value === state).length;
    const applied = count("applied");
    const discarded = count("discarded");
    const waiting = states.size - applied - discarded;
    if (applied && !discarded && !waiting && counted(true) === 0) return t`Applied ${what}`;
    if (discarded && !applied && !waiting && counted(true) === 0) return t`Discarded ${what}`;
    if (applied && discarded && waiting)
      return t`Drafted ${what}: ${applied} applied, ${discarded} discarded, ${waiting} still a draft`;
    if (applied && discarded) return t`Drafted ${what}: ${applied} applied, ${discarded} discarded`;
    if (applied && waiting) return t`Drafted ${what}: ${applied} applied, ${waiting} still a draft`;
    if (discarded && waiting)
      return t`Drafted ${what}: ${discarded} discarded, ${waiting} still a draft`;
    return t`Drafted ${what}`;
  }
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
function reversedWorkLine(
  work: { workId: string; name: string; status: string },
  names: OwnerNames,
): string {
  const name = names({ kind: "work-id", workId: work.workId }) ?? work.name;
  return work.status === "redone"
    ? t`Redid change to Work ${name}.`
    : t`Undid change to Work ${name}.`;
}

/** Where a tree inverse actually committed when its recorded name was no longer free. */
function treeLandingLine(landing: TreeReversalLanding, names: OwnerNames): string {
  return landing.action === "restored"
    ? t`Restored as ${documentDisplayName(landing.landedAt)}.`
    : t`Moved to ${documentLocationName(landing.landedAt, names)}.`;
}
