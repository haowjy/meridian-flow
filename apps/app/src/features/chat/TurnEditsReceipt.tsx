/** Renders durable document and Work change receipts. */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { agentsLocationOf } from "@meridian/contracts/agents";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type {
  ReversalOutcome,
  TreeReversalLanding,
  Turn,
  TurnDraftState,
  TurnInverseSkip,
  TurnLiveLineageDocumentItem,
  TurnReceiptChip,
  TurnTreeLine,
  TurnTreeState,
} from "@meridian/contracts/protocol";
import { isReversibleWorkReceipt } from "@meridian/contracts/works";
import type { WorkReceipt } from "@meridian/thread-client";
import { useEffect, useId, useState } from "react";
import { successfulWorkReversals } from "@/client/api/reverse-api";
import { useReverseTurnMutation } from "@/client/query/useReverseMutation";
import { Button } from "@/components/ui/button";
import { FoldToggle } from "@/components/ui/fold-toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MIDDLE_BUTTON } from "@/core/editor/links";
import { unappliedSentence } from "@/core/project-tree/tree-left-sentence";
import type { TreeFact, Unapplied } from "@/core/project-tree/tree-undo";
import { AgentFileSave } from "@/features/agents/PackageSave";
import { packageFolderOf, packageLabel } from "@/features/agents/package-save";
import { useAppliedCommands } from "@/features/draft-review/CommandNotice";
import { useCardUnapply } from "@/features/draft-review/card-unapply";
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
  textSkipCauseCopy,
  treeSkipSentence,
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
  // The parts the writer's last Undo left.
  const [actionSkips, setActionSkips] = useState<TurnInverseSkip[] | null>(null);
  const [commandRefusal, setCommandRefusal] = useState<ReversalRefusal | null>(null);
  const [outcomeNotices, setOutcomeNotices] = useState<string[] | null>(null);
  const turnMutation = useReverseTurnMutation(threadId);
  const projectId = useProjectDocumentNavigationProjectId();
  const unapply = useCardUnapply(projectId);
  const appliedCommands = useAppliedCommands();
  // What the card's last Undo of its applied changes left standing for good, said where pressed.
  const [left, setLeft] = useState<
    (Unapplied & { count: number; facts: ReadonlyMap<string, TreeFact> }) | null
  >(null);

  const drafts = receipt?.drafts;
  const trees = receipt?.trees;
  // The tree change the refusal line already names isn't listed a second time, nor is a
  // drafted document's apply or discard, or its draft waiting in a closed Work: its row and the
  // Work's review say what became of it.
  const skips = (actionSkips ?? receipt?.skips ?? []).filter(
    (skip) =>
      !(commandRefusal?.status === "not_undone" && skip === commandRefusal.stayed) &&
      !(
        (drafts?.[skip.documentId] || trees?.[skip.documentId]) &&
        (skip.cause === "applied" || skip.cause === "discarded" || skip.cause === "returned")
      ),
  );
  const names = useOwnerNames();
  const guardCopy = commandRefusal ? reversalRefusalCopy(commandRefusal) : undefined;
  const isFolder = (documentId: string) =>
    documents.some((document) => document.documentId === documentId && document.folder);
  const hasEditedDocuments = documents.length > 0;
  // Reversible Work mutation receipts are content in their own right: their
  // lines list as rows, and their presence is what keeps a Work-only turn's
  // Undo on screen.
  const reversibleWorkReceipts = workReceipts.filter(isReversibleWorkReceipt);
  // The Applies in force that took this reply's changes, as the server listed them and as this
  // tab's owner of each (`AppliedCommand`) has them now: the Undo takes each back whole. One that
  // waits for a closed owner says so, on every card that lists it, until the owner reopens.
  const listed = (receipt?.applied ?? []).map((apply) => ({
    apply,
    command: appliedCommands.find(apply.commandId),
  }));
  const waiting = listed.flatMap(({ command }) => (command?.waits() ? [command] : []));
  const applies = listed.flatMap(({ apply, command }) =>
    !command || command.offersUndo() ? [apply] : [],
  );
  const asking = listed.some(
    ({ command }) => command?.state.kind === "unapplying" || command?.state.kind === "reapplying",
  );
  const reverses = receipt?.control === "undo";
  const reversible = reverses || applies.length > 0;
  const appliedCount = applies.reduce((sum, apply) => sum + apply.count, 0);
  const wholeApply = applies.length > 1 || (applies[0] !== undefined && !applies[0].onlyThisTurn);
  // What each listed Apply did to a node, as the Changes row names it: this tab's own Applies
  // read it from the tree, and one the card made an owner for, from the card's tree lines.
  const cardFacts = treeFactsOf(documents, trees);
  const factsNow = () =>
    new Map([
      ...cardFacts,
      ...listed.flatMap(({ command }) => (command ? [...command.facts] : [])),
    ]);
  const heldParts = waiting.flatMap((command) => command.held);
  const said = heldParts.length
    ? {
        taken: "nothing" as const,
        leftOut: left?.leftOut ?? [],
        held: heldParts,
        count: listed.reduce((sum, { apply }) => sum + apply.count, 0),
        facts: factsNow(),
      }
    : left;

  useEffect(() => {
    if (receipt?.control !== "view_change") setCommandRefusal(null);
  }, [receipt?.control]);

  if (!hasTurnEditsReceiptContent(documents, workReceipts)) return null;

  /** What the reversal of the reply's changes no Apply took answered, said on the card. */
  function answered(outcome: ReversalOutcome) {
    setActionSkips(outcome.skips ?? []);
    const restored = successfulWorkReversals(outcome);
    const status =
      outcome.status === "partial" && outcome.acceptedParts
        ? null
        : refusedReversalStatus(outcome.status);
    // A part a closed Work kept as it was is listed below with its reason; it isn't a refusal.
    const onlyReturned =
      !!outcome.skips?.length && outcome.skips.every((skip) => skip.cause === "returned");
    const refusal = status && !onlyReturned ? status : null;
    // Several tree changes that stayed are listed, each with why, under the list's heading.
    const stayed = outcome.skips?.length === 1 ? outcome.skips[0] : undefined;
    setCommandRefusal(
      refusal === "not_undone"
        ? stayed?.kind === "tree"
          ? { status: refusal, stayed, folder: isFolder(stayed.documentId) }
          : null
        : refusal
          ? { status: refusal, denial: outcome.denial }
          : null,
    );
    const notices = [
      ...(outcome.landings ?? []).map((landing) => treeLandingLine(landing, names)),
      ...restored.map((work) => reversedWorkLine(work, names)),
    ];
    setOutcomeNotices(notices.length ? [...new Set(notices)] : null);
    if (refusal || notices.length > 0 || outcome.skips?.length) setExpanded(true);
  }

  async function reverseTurn() {
    if (pending || asking || !reversible) return;
    setPending(true);
    setLeft(null);
    try {
      // One press: the reversal of what no Apply took, then each Apply's Un-Apply. In this order
      // the reversal never sees a part the Un-Apply drafted again, so the draft keeps it.
      const outcome = reverses ? await turnMutation.mutateAsync({ turnId: turn.id }) : null;
      const facts = factsNow();
      const taken = applies.length ? await unapply(applies, cardFacts) : null;
      if (outcome) answered(outcome);
      if (taken?.taken === "failed") {
        setCommandRefusal({ status: "request_failed" });
        setExpanded(true);
      } else if (taken && (taken.taken === "partly" || taken.taken === "nothing")) {
        setLeft(taken.leftOut.length ? { ...taken, held: [], count: appliedCount, facts } : null);
        setExpanded(true);
      }
    } catch {
      // A rejected request is a refusal the writer never asked for: the command
      // is the only thing that can report it, so it says so here rather than
      // leaving the click looking like it worked.
      setCommandRefusal({ status: "request_failed" });
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
              ? documentCountLabel(documents, drafts, trees)
              : workCountLabel(reversibleWorkReceipts.length)}
          </span>
        </FoldToggle>
        {reversible ? (
          <UndoButton
            pending={pending || asking}
            wholeApply={wholeApply ? appliedCount : null}
            onUndo={() => void reverseTurn()}
          />
        ) : waiting.length ? (
          <span className="ml-auto shrink-0 text-muted-foreground" role="status">
            <Trans>Not undone</Trans>
          </span>
        ) : (
          <UndoneWord state={receipt?.state} />
        )}
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
                {receipt?.state === "expired"
                  ? t`What happened to each part`
                  : skipsHeading(skips.length, actionSkips !== null || receipt?.state === "partly")}
              </p>
              <ul>
                {skips.map((skip, index) => (
                  <li key={`${skip.documentId}:${index}`}>
                    <SkipSubject skip={skip} />
                    <span className="ml-1">
                      {skip.kind === "tree"
                        ? treeSkipSentence(skip, isFolder(skip.documentId))
                        : textSkipCauseCopy(skip)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {said ? (
            <p
              className="px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)] pl-[var(--chat-geometry-receipt-indent)] text-foreground"
              data-unapply-outcome
              role="status"
            >
              {unappliedSentence({
                ...said,
                facts: namedFacts(documents, said.facts),
                name:
                  documents.length === 1 && documents[0]
                    ? documentDisplayName(documents[0].uri)
                    : changeCount(said.count),
                nodes: [
                  ...new Set([
                    ...said.leftOut.map((one) => one.node),
                    ...said.held.map((one) => one.node),
                  ]),
                ],
              })}
            </p>
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
                    halves={halvesOf(doc, drafts, trees)}
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
  halves,
  onOpenContextUri,
  canOpenContextUri,
}: {
  document: TurnEditDocument;
  /** What became of each half the turn drafted. */
  halves: Halves;
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
        <DraftStateWord halves={halves} op={document.tree?.op} />
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
      <DraftStateWord halves={halves} op={document.tree?.op} />
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

/** What became of a row's drafted text (`text`) and tree change (`tree`), each when the turn drafted it. */
type Halves = { text?: TurnDraftState; tree?: TurnTreeState };

/** What each node's drafted tree change on the card did, named as its line names it. */
function treeFactsOf(
  documents: readonly TurnEditDocument[],
  trees: TurnReceiptChip["trees"],
): Map<string, TreeFact> {
  return new Map(
    documents.flatMap((document) =>
      trees?.[document.documentId]
        ? [[document.documentId, { did: didOf(document.tree), folder: !!document.folder }]]
        : [],
    ),
  );
}

/** The facts a line says, each naming its document: a card lists several apart from their rows. */
function namedFacts(
  documents: readonly TurnEditDocument[],
  facts: ReadonlyMap<string, TreeFact>,
): Map<string, TreeFact> {
  const named = new Map(facts);
  for (const document of documents) {
    const fact = facts.get(document.documentId);
    named.set(document.documentId, {
      did: fact?.did ?? null,
      folder: fact?.folder ?? !!document.folder,
      name: (document.folder ? folderDisplayName : documentDisplayName)(document.uri),
    });
  }
  return named;
}

function didOf(line: TurnTreeLine | undefined): TreeFact["did"] {
  if (!line || line.op === "copy") return "created";
  if (line.op === "delete") return "deleted";
  return describeModelMove(line.from, line.to).kind === "rename" ? "renamed" : "moved";
}

function halvesOf(
  document: TurnEditDocument,
  drafts: TurnReceiptChip["drafts"],
  trees: TurnReceiptChip["trees"],
): Halves {
  if (document.scope !== "draft") return {};
  const text = document.folder ? undefined : drafts?.[document.documentId];
  const tree = trees?.[document.documentId];
  return { ...(text ? { text } : {}), ...(tree ? { tree } : {}) };
}

/** One state for a row: waiting while a half waits; else applied when a half landed. */
function stateOf({ text, tree }: Halves): TurnTreeState | undefined {
  if (text === "pending" || tree === "pending") return "pending";
  if (text === "applied" || tree === "applied") return "applied";
  return tree === "replaced" ? tree : (text ?? tree);
}

/**
 * What became of a row's drafted change: one word when its halves agree ("Applied"; one still
 * waiting needs none), and each half's when they differ ("Text applied, move still a draft").
 */
function DraftStateWord({ halves, op }: { halves: Halves; op: TurnTreeLine["op"] | undefined }) {
  const { text, tree } = halves;
  const word =
    text && tree && text !== tree
      ? t`Text ${halfState(text)}, ${treeNoun(op)} ${halfState(tree)}`
      : stateWord(text ?? tree);
  if (!word) return null;
  return (
    <span
      className="ml-auto shrink-0 pl-2 text-muted-foreground"
      data-draft-state={stateOf(halves)}
    >
      {word}
    </span>
  );
}

function stateWord(state: TurnTreeState | undefined): string | null {
  if (state === "applied") return t`Applied`;
  if (state === "discarded") return t`Discarded`;
  if (state === "replaced") return t`Replaced by a later change`;
  return null;
}

function halfState(state: TurnTreeState): string {
  if (state === "applied") return t`applied`;
  if (state === "discarded") return t`discarded`;
  if (state === "replaced") return t`replaced by a later one`;
  return t`still a draft`;
}

/** The tree half, named by what the turn did: a document with no tree line was made by it. */
function treeNoun(op: TurnTreeLine["op"] | undefined): string {
  if (op === "move") return t`move`;
  if (op === "delete") return t`delete`;
  if (op === "copy") return t`copy`;
  return t`new document`;
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
 * "Drafted" when every change went into a draft and some still wait; "Applied" or "Discarded"
 * once every one of them, text and tree alike, has had that outcome; the mix said in counts when
 * they differ. Else
 * "Edited" while the turn only changed text, "Changed" once it moved, deleted or made something
 * or wrote both drafts and the manuscript. Documents and folders are counted apart, so a
 * reorganisation says it touched folders too. It counts, never names: a name inside the toggle
 * would compete for the click with the expanded rows, which already open each document.
 */
function documentCountLabel(
  documents: readonly TurnEditDocument[],
  drafts: TurnReceiptChip["drafts"],
  trees: TurnReceiptChip["trees"],
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
    const states = new Map<string, TurnTreeState | undefined>(
      documents.map((document) => [
        document.documentId,
        stateOf(halvesOf(document, drafts, trees)),
      ]),
    );
    const count = (state: TurnTreeState) =>
      [...states.values()].filter((value) => value === state).length;
    const applied = count("applied");
    const replaced = count("replaced");
    const discarded = count("discarded");
    const waiting = states.size - applied - replaced - discarded;
    if (applied === states.size) return t`Applied ${what}`;
    if (discarded === states.size) return t`Discarded ${what}`;
    if (waiting === states.size) return t`Drafted ${what}`;
    return draftedMix(what, { applied, replaced, discarded, waiting });
  }
  if (documents.some((document) => document.scope === "draft" || document.tree || document.folder))
    return t`Changed ${what}`;
  return t`Edited ${what}`;
}

/**
 * A reply's drafted rows that ended in more than one way, each mix one whole message for
 * translators.
 */
function draftedMix(
  what: string,
  n: { applied: number; replaced: number; discarded: number; waiting: number },
): string {
  const { applied, replaced, discarded, waiting } = n;
  const mix = `${applied ? "a" : ""}${replaced ? "r" : ""}${discarded ? "d" : ""}${waiting ? "w" : ""}`;
  switch (mix) {
    case "r":
      return t`Drafted ${what}: ${replaced} replaced by a later change`;
    case "ar":
      return t`Drafted ${what}: ${applied} applied, ${replaced} replaced by a later change`;
    case "ad":
      return t`Drafted ${what}: ${applied} applied, ${discarded} discarded`;
    case "aw":
      return t`Drafted ${what}: ${applied} applied, ${waiting} still a draft`;
    case "rd":
      return t`Drafted ${what}: ${replaced} replaced by a later change, ${discarded} discarded`;
    case "rw":
      return t`Drafted ${what}: ${replaced} replaced by a later change, ${waiting} still a draft`;
    case "dw":
      return t`Drafted ${what}: ${discarded} discarded, ${waiting} still a draft`;
    case "ard":
      return t`Drafted ${what}: ${applied} applied, ${replaced} replaced by a later change, ${discarded} discarded`;
    case "arw":
      return t`Drafted ${what}: ${applied} applied, ${replaced} replaced by a later change, ${waiting} still a draft`;
    case "adw":
      return t`Drafted ${what}: ${applied} applied, ${discarded} discarded, ${waiting} still a draft`;
    case "rdw":
      return t`Drafted ${what}: ${replaced} replaced by a later change, ${discarded} discarded, ${waiting} still a draft`;
    default:
      return t`Drafted ${what}: ${applied} applied, ${replaced} replaced by a later change, ${discarded} discarded, ${waiting} still a draft`;
  }
}

/**
 * What the listed parts are: the ones an Undo left as they were, or, before one, the ones it
 * would leave (a stopped turn's rolled-back parts, an applied draft).
 */
function skipsHeading(count: number, undone: boolean): string {
  if (undone)
    return plural(count, {
      one: "Undo left # part as it was",
      other: "Undo left # parts as they were",
    });
  return plural(count, {
    one: "Undo leaves # part as it is",
    other: "Undo leaves # parts as they are",
  });
}

/**
 * The card's Undo. When it takes back a whole Apply that held more than this reply's changes
 * (`wholeApply`: how many it held in all), it says so, as the Changes row does.
 */
function UndoButton({
  pending,
  wholeApply,
  onUndo,
}: {
  pending: boolean;
  wholeApply: number | null;
  onUndo: () => void;
}) {
  const takes =
    wholeApply === null
      ? null
      : plural(wholeApply, {
          one: "Takes back the whole Apply, # change.",
          other: "Takes back the whole Apply, all # changes.",
        });
  const button = (
    <Button
      type="button"
      variant="quiet"
      size="meta"
      onClick={(event) => {
        event.stopPropagation();
        onUndo();
      }}
      disabled={pending}
      aria-description={takes ?? undefined}
      className="ml-auto shrink-0 text-jade-text"
    >
      {pending ? t`Undoing…` : takes ? t`Undo Apply` : t`Undo`}
    </Button>
  );
  if (!takes) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{takes}</TooltipContent>
    </Tooltip>
  );
}

/** What the card's Un-Apply of its applied changes did, in the Undo's place. */
const changeCount = (count: number) => plural(count, { one: "# change", other: "# changes" });

/** Where Undo sat once the writer's Undo ran; an expired card has no word. */
function UndoneWord({ state }: { state: TurnReceiptChip["state"] | undefined }) {
  if (state !== "undone" && state !== "partly") return null;
  return (
    <span className="ml-auto shrink-0 text-muted-foreground" role="status">
      {state === "partly" ? <Trans>Partly undone</Trans> : <Trans>Undone</Trans>}
    </span>
  );
}

/**
 * What a part that stayed was: its text excerpts, or the place a tree change named, whole, so the
 * writer can find it.
 */
function SkipSubject({ skip }: { skip: TurnInverseSkip }) {
  const names = useOwnerNames();
  if (skip.kind === "tree") return <>{documentLocationName(skip.at ?? skip.uri, names)}</>;
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
function reversedWorkLine(work: { workId: string; name: string }, names: OwnerNames): string {
  const name = names({ kind: "work-id", workId: work.workId }) ?? work.name;
  return t`Undid change to Work ${name}.`;
}

/** Where a tree inverse actually committed when its recorded name was no longer free. */
function treeLandingLine(landing: TreeReversalLanding, names: OwnerNames): string {
  return landing.action === "restored"
    ? t`Restored as ${documentDisplayName(landing.landedAt)}.`
    : t`Moved to ${documentLocationName(landing.landedAt, names)}.`;
}
