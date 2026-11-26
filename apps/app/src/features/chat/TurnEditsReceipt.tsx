import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { DraftId, TurnId } from "@meridian/contracts";
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
import { useId, useState, useSyncExternalStore } from "react";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { useReverseTurnMutation } from "@/client/query/useReverseMutation";
import { notifyFailure } from "@/components/app/failure-toast";
import { FoldToggle } from "@/components/ui/fold-toggle";
import { MIDDLE_BUTTON } from "@/core/editor/links";
import { AgentFileSave } from "@/features/agents/PackageSave";
import { packageFolderOf, packageLabel } from "@/features/agents/package-save";
import { useReferenceDrag } from "@/features/project/context/entry-drag/reference-source";
import { useProjectDocumentNavigationProjectId } from "@/features/project/context/open-project-document";
import { useItemLauncher } from "@/features/project/review-launch";
import {
  type CanOpenContextUri,
  type OpenContextUri,
  useChatContextNavigation,
  useChatContextRoutability,
} from "./ChatContextNavigation";
import { DocumentName } from "./DocumentName";
import { describeModelMove, documentDisplayName, folderDisplayName } from "./document-display-name";
import { useOwnerNames } from "./owner-names";
import { TurnRestoreSlot } from "./TurnRestore";
import { useTurnCardDrafts } from "./turn-card-drafts";
import { UndoCell } from "./UndoCell";
import { workReceiptLine } from "./work-receipt-copy";

const UNDO_FAILED: ReadonlySet<string> = new Set([
  "partial_failure",
  "permission_denied",
  "internal_error",
]);

export type TurnEditDocument = TurnLiveLineageDocumentItem;

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
  receiptReadAt?: number;
  workReceipts?: readonly WorkReceipt[];
};

export function TurnEditsReceipt({
  threadId,
  turn,
  documents,
  receipt,
  receiptReadAt = 0,
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
  const restores = useTurnRestores(turn, documents, receipt, receiptReadAt);
  const hasEditedDocuments = documents.length > 0;
  const names = useOwnerNames();
  // Reversible Work mutation receipts are content in their own right: their
  // lines list as rows, and their presence is what keeps a Work-only turn's
  // Undo on screen.
  const reversibleWorkReceipts = workReceipts.filter(isReversibleWorkReceipt);
  const reversible = receipt?.control === "undo";

  if (!hasTurnEditsReceiptContent(documents, workReceipts)) return null;

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
        {restores.drafts.length === 1 ? restores.slot(restores.drafts[0] as DraftId, false) : null}
        {reversible || receipt?.undone || restores.drafts.length === 0 ? (
          <UndoCell
            offer={
              reversible ? { label: t`Undo`, pending, onPress: () => void reverseTurn() } : null
            }
            undone={receipt?.undone === true}
          />
        ) : null}
      </div>
      {projectId ? (
        <AgentPackagesSaveLines projectId={projectId} documents={documents} drafts={drafts} />
      ) : null}
      {expanded ? (
        <div id={panelId} className="border-border-subtle border-t">
          {restores.groups.map((group) => (
            <div key={group.draft ?? "live"}>
              {group.draft ? (
                <div className="flex min-h-6 items-center px-[var(--chat-card-pad-x)] text-foreground">
                  <span className="min-w-0 flex-1 truncate font-medium">{group.name}</span>
                  {restores.slot(group.draft, true)}
                </div>
              ) : null}
              <ul className="flex flex-col">
                {group.documents.map((doc) => (
                  <li key={`${doc.scope === "draft" ? doc.draft : "live"}:${doc.uri}`}>
                    <DocumentRow
                      document={doc}
                      state={draftStateOf(doc, drafts)}
                      onOpenContextUri={openContextUri}
                      canOpenContextUri={canOpenContextUri}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
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

function useTurnRestores(
  turn: Turn,
  documents: readonly TurnEditDocument[],
  receipt: TurnReceiptChip | null,
  readAt: number,
) {
  const cards = useTurnCardDrafts();
  const owner = cards?.commands.owner;
  useSyncExternalStore(
    owner?.subscribe ?? noSubscription,
    owner?.snapshot ?? noSnapshot,
    owner?.snapshot ?? noSnapshot,
  );
  const turnId = turn.id as TurnId;
  const offered = receipt?.restore ?? [];
  const drafts: DraftId[] = cards
    ? [
        ...new Set([
          ...offered,
          ...(receipt?.restored ?? []).map((each) => each.draft),
          ...(owner?.restoredDrafts(turnId) ?? []),
        ]),
      ]
    : [];
  const nameOf = (draft: string) => cards?.nameOf(draft) ?? "";
  const written = (draft: string) =>
    documents.filter((doc) => doc.scope === "draft" && doc.draft === draft);
  const several = drafts.length > 1;
  const groups: { draft: DraftId | null; name: string | null; documents: TurnEditDocument[] }[] =
    several
      ? [
          {
            draft: null,
            name: null,
            documents: documents.filter(
              (doc) => doc.scope !== "draft" || !drafts.includes(doc.draft),
            ),
          },
          ...drafts.map((draft) => ({ draft, name: nameOf(draft), documents: written(draft) })),
        ]
      : [{ draft: null, name: null, documents: [...documents] }];
  return {
    drafts,
    groups: groups.filter((group) => group.draft || group.documents.length > 0),
    slot: (draft: DraftId, named: boolean) =>
      cards ? (
        <TurnRestoreSlot
          key={draft}
          commands={cards.commands}
          turn={turnId}
          draft={draft}
          documents={written(draft)
            .filter((doc) => !doc.folder)
            .map((doc) => doc.documentId)}
          name={named ? nameOf(draft) : null}
          offered={offered.includes(draft)}
          named={
            receipt
              ? (receipt.restored?.find((each) => each.draft === draft)?.press ?? null)
              : undefined
          }
          readAt={readAt}
        />
      ) : null,
  };
}

const noSubscription = () => () => {};
const noSnapshot = () => 0;

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

function DocumentRow({
  document,
  state,
  onOpenContextUri,
  canOpenContextUri,
}: {
  document: TurnEditDocument;
  state: TurnDraftState | undefined;
  onOpenContextUri: OpenContextUri | null;
  canOpenContextUri: CanOpenContextUri | null;
}) {
  const drag = useDocumentRowDrag(document);
  // A chapter the turn drafted that still has changes opens in Review changes; any other row
  // opens as a link does.
  const projectId = useProjectDocumentNavigationProjectId();
  const draftId = document.scope === "draft" ? document.draft : null;
  const drafted = useOwnerDrafts(projectId ?? null, draftId).fileForDocument(document.documentId);
  const { openReviewFile } = useItemLauncher();
  const open = () => {
    if (draftId && drafted?.item.pending) openReviewFile(drafted, draftId, document.block);
    else onOpenContextUri?.(document.uri);
  };
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
      onClick={open}
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

function draftStateOf(
  document: TurnEditDocument,
  drafts: TurnReceiptChip["drafts"],
): TurnDraftState | undefined {
  return document.scope === "draft" ? drafts?.[document.documentId] : undefined;
}

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
  return <DocumentName path={document.uri} insideDoor />;
}

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

function workCountLabel(count: number) {
  return count === 1 ? <Trans>Changed 1 Work</Trans> : <Trans>Changed {count} Work</Trans>;
}
