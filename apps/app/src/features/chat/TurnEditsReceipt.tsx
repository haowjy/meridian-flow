/** Renders durable document and Work change receipts. */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { agentsLocationOf } from "@meridian/contracts/agents";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type {
  Turn,
  TurnDraftState,
  TurnLiveLineageDocumentItem,
  TurnReceiptChip,
} from "@meridian/contracts/protocol";
import { isReversibleWorkReceipt } from "@meridian/contracts/works";
import type { WorkReceipt } from "@meridian/thread-client";
import { useId, useState } from "react";
import { useReverseTurnMutation } from "@/client/query/useReverseMutation";
import { notifyFailure } from "@/components/app/failure-toast";
import { Button } from "@/components/ui/button";
import { FoldToggle } from "@/components/ui/fold-toggle";
import { MIDDLE_BUTTON } from "@/core/editor/links";
import { AgentFileSave } from "@/features/agents/PackageSave";
import { packageFolderOf, packageLabel } from "@/features/agents/package-save";
import { useReferenceDrag } from "@/features/project/context/entry-drag/reference-source";
import { useProjectDocumentNavigationProjectId } from "@/features/project/context/open-project-document";
import {
  type CanOpenContextUri,
  type OpenContextUri,
  useChatContextNavigation,
  useChatContextRoutability,
} from "./ChatContextNavigation";
import { DocumentName } from "./DocumentName";
import { describeModelMove, documentDisplayName, folderDisplayName } from "./document-display-name";
import { useOwnerNames } from "./owner-names";
import { workReceiptLine } from "./work-receipt-copy";

/** The answers that mean the press failed; every other answer is a press that took what it could. */
const UNDO_FAILED: ReadonlySet<string> = new Set([
  "partial_failure",
  "permission_denied",
  "internal_error",
]);

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
  const turnMutation = useReverseTurnMutation(threadId);
  const projectId = useProjectDocumentNavigationProjectId();

  const drafts = receipt?.drafts;
  const hasEditedDocuments = documents.length > 0;
  const names = useOwnerNames();
  // Reversible Work mutation receipts are content in their own right: their
  // lines list as rows, and their presence is what keeps a Work-only turn's
  // Undo on screen.
  const reversibleWorkReceipts = workReceipts.filter(isReversibleWorkReceipt);
  const reversible = receipt?.control === "undo";

  if (!hasTurnEditsReceiptContent(documents, workReceipts)) return null;

  /** One press, one command: it takes what it can and says nothing. Only a failure shows, as a toast. */
  async function reverseTurn() {
    if (pending || !reversible) return;
    setPending(true);
    try {
      const outcome = await turnMutation.mutateAsync({ turnId: turn.id });
      if (UNDO_FAILED.has(outcome.status)) throw new Error(outcome.status);
    } catch {
      notifyFailure({ key: `undo:${turn.id}`, title: t`Couldn't undo`, brief: true });
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
        <UndoSlot
          reversible={reversible}
          pending={pending}
          undone={receipt?.undone === true}
          onUndo={() => void reverseTurn()}
        />
      </div>
      {projectId ? (
        <AgentPackagesSaveLines projectId={projectId} documents={documents} drafts={drafts} />
      ) : null}
      {expanded ? (
        <div id={panelId} className="border-border-subtle border-t">
          {documents.length > 0 ? (
            <ul className="flex flex-col">
              {documents.map((doc) => (
                <li key={doc.uri}>
                  <DocumentRow
                    document={doc}
                    state={draftStateOf(doc, drafts)}
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
  state,
  onOpenContextUri,
  canOpenContextUri,
}: {
  document: TurnEditDocument;
  /** What became of the change the turn drafted to this row. */
  state: TurnDraftState | undefined;
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
        className="flex min-h-6 min-w-0 flex-wrap items-center px-[var(--chat-card-pad-x)] pl-[var(--chat-geometry-receipt-indent)] text-foreground"
      >
        <DocumentRowLabel document={document} />
        <DraftStateWord state={state} />
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
      className="focus-ring flex min-h-6 w-full flex-wrap items-center px-[var(--chat-card-pad-x)] pl-[var(--chat-geometry-receipt-indent)] text-left transition-colors hover:bg-ink-fill"
    >
      <DocumentRowLabel document={document} />
      <DraftStateWord state={state} />
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
              ? { kind: "draft", draft: document.draft }
              : { kind: "live" },
        }
      : null,
  );
}

/** What became of a row's drafted change, when the turn drafted it. */
function draftStateOf(
  document: TurnEditDocument,
  drafts: TurnReceiptChip["drafts"],
): TurnDraftState | undefined {
  return document.scope === "draft" ? drafts?.[document.documentId] : undefined;
}

/** One word for a row's drafted change; one still waiting needs none, the header says Drafted. */
function DraftStateWord({ state }: { state: TurnDraftState | undefined }) {
  const word = stateWord(state);
  if (!word) return null;
  return (
    <span className="ml-auto shrink-0 pl-2 text-muted-foreground" data-draft-state={state}>
      {word}
    </span>
  );
}

function stateWord(state: TurnDraftState | undefined): string | null {
  if (state === "applied") return t`Applied`;
  if (state === "undone") return t`Undone`;
  if (state === "discarded") return t`Discarded`;
  return null;
}

/** A row's words: the node's name (a folder's where the turn left it), or what the turn did to where it is. */
function DocumentRowLabel({ document }: { document: TurnEditDocument }) {
  const names = useOwnerNames();
  const tree = document.tree;
  const nameOf = document.folder ? folderDisplayName : documentDisplayName;
  if (tree?.op === "move") {
    const source = nameOf(tree.from);
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
    const source = nameOf(tree.from);
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
    const name = nameOf(tree.from);
    return (
      <span className="min-w-0 truncate text-foreground" data-turn-tree-line="delete">
        <Trans>Deleted {name}</Trans>
      </span>
    );
  }
  if (document.folder)
    return <span className="min-w-0 truncate text-foreground">{nameOf(document.uri)}</span>;
  // The whole row is the door here, so the name inside it stays inert.
  return <DocumentName path={document.uri} insideDoor />;
}

/**
 * "Applied", "Undone" or "Discarded" once every drafted change has had that outcome, else
 * "Drafted" while any waits or they differ (each row says its own). Else "Edited" while the turn
 * only changed text, "Changed" once it moved, deleted or made something or wrote both drafts and
 * the manuscript. Documents and folders are counted apart, so a reorganisation says it touched
 * folders too. It counts, never names: a name inside the toggle would compete for the click with
 * the expanded rows, which already open each document.
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
    const states = new Set(documents.map((document) => draftStateOf(document, drafts)));
    if (states.size === 1) {
      if (states.has("applied")) return t`Applied ${what}`;
      if (states.has("undone")) return t`Undone ${what}`;
      if (states.has("discarded")) return t`Discarded ${what}`;
    }
    return t`Drafted ${what}`;
  }
  if (documents.some((document) => document.scope === "draft" || document.tree || document.folder))
    return t`Changed ${what}`;
  return t`Edited ${what}`;
}

/**
 * The card's one slot: Undo while a press would take something back, "Undoing…" while it runs,
 * "Undone" once it did, else empty. Its width never changes, so none of these moves what sits
 * beside it.
 */
function UndoSlot({
  reversible,
  pending,
  undone,
  onUndo,
}: {
  reversible: boolean;
  pending: boolean;
  undone: boolean;
  onUndo: () => void;
}) {
  return (
    <span className="ml-auto flex min-w-[5rem] shrink-0 items-center justify-end">
      {reversible ? (
        <Button
          type="button"
          variant="quiet"
          size="meta"
          onClick={(event) => {
            event.stopPropagation();
            onUndo();
          }}
          disabled={pending}
          className="text-jade-text"
        >
          {pending ? t`Undoing…` : t`Undo`}
        </Button>
      ) : undone ? (
        <span className="text-muted-foreground" role="status">
          <Trans>Undone</Trans>
        </span>
      ) : null}
    </span>
  );
}

/** The Work-only header: same counting grammar as documents, wearing the
 * writer's own word for the entity the turn changed. */
function workCountLabel(count: number) {
  return count === 1 ? <Trans>Changed 1 Work</Trans> : <Trans>Changed {count} Work</Trans>;
}
