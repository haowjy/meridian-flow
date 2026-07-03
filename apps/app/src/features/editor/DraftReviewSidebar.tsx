/**
 * DraftReviewSidebar — proposal cards for inline draft review.
 *
 * The sidebar reads the inline-review plugin state (operations + hunks +
 * active operation), sorts operations into document order, and renders one
 * card per operation with attribution badge and Discard button. Clicking a
 * card emphasises the matching hunks in the editor and scrolls the editor to
 * them; clicking a highlighted region in the editor promotes that
 * operation's card and scrolls it into view here.
 *
 * Per-operation Discard delegates to the inline-review controller, which
 * reverses that operation's Yjs update rows on the draft doc so the reject is
 * synced normally and remains undoable with Ctrl+Z.
 */
import { Trans } from "@lingui/react/macro";
import type { ReviewOperation } from "@meridian/contracts/drafts";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { useEditorState } from "@tiptap/react";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAcceptDraft, useUndoDraftAccept } from "@/client/query/useDraftReviewMutations";
import { Button } from "@/components/ui/button";
import {
  getInlineReviewPluginState,
  type InlineReviewPluginState,
} from "@/core/editor/extensions/inline-review";
import { operationRejectIsMixed } from "@/core/editor/inline-review-runtime";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { cn } from "@/lib/utils";
import type { InlineReviewRejectOutcome } from "./useInlineReviewRejectOperation";

export type DraftReviewSidebarProps = {
  editor: Editor | null;
  className?: string;
  /** Runs the undoable client-side reject for a single operation. */
  onDiscardOperation?: (
    operationId: string,
  ) => Promise<InlineReviewRejectOutcome> | InlineReviewRejectOutcome;
};

interface SidebarSnapshot {
  pluginState: InlineReviewPluginState | null;
  entries: OrderedOperation[];
  /** Card groups derived from block adjacency — one visual stack per passage. */
  groups: OrderedOperation[][];
}

const EMPTY_SNAPSHOT: SidebarSnapshot = { pluginState: null, entries: [], groups: [] };

/**
 * Minimal hunk shape the ordering logic reads. Structural so both the raw
 * server `ReviewHunk` and the plugin's `ResolvedReviewHunk` (which lives in
 * the editor extension and carries `Y.RelativePosition` anchors) satisfy it
 * without a conversion step.
 */
interface SidebarHunkInput {
  hunkId: string;
  operationIds: string[];
  deletedText?: string;
}

/** Shape derived from an operation's own contribution — drives the writer-facing verb. */
type OperationShape = "insert" | "delete" | "replace" | "mixed";

export interface HunkPositionRange {
  /** Absolute draft-doc position where the hunk anchor resolves to. */
  from: number;
  /** Draft-doc end position for insertion hunks; equal to `from` for pure deletions. */
  to: number;
  /** True when the hunk carries removed text (deletion widget shown). */
  hasDeletion: boolean;
}

interface HunkResolution {
  hunkId: string;
  operationIds: string[];
  range: HunkPositionRange | null;
  hasDeletion: boolean;
  /** Text removed from live but absent in draft — kept verbatim for the
   *  sidebar's inline preview so we don't have to re-thread the raw model. */
  deletedText?: string;
}

export interface OrderedOperation {
  operation: ReviewOperation;
  /** Hunks belonging to this operation, in document order. */
  hunks: HunkResolution[];
  /** Absolute anchor position of the earliest resolvable hunk — sort key. */
  firstPos: number;
  /** Derived shape used to pick the summary verb. */
  shape: OperationShape;
  /** True when this operation itself removed text; gates deletion previews. */
  hasOwnDeletion: boolean;
  /** True when an AI operation shares at least one colored hunk with writer edits. */
  includesWriterEdits: boolean;
}

/**
 * Assemble ordered operation entries from the raw review model + resolved
 * hunk positions. Operations with no resolvable hunk are appended at the end
 * in stable input order so they stay visible instead of vanishing between
 * re-renders — the sidebar shows a fallback summary for these.
 */
export function orderOperationsForSidebar(
  operations: readonly ReviewOperation[],
  hunks: readonly SidebarHunkInput[],
  hunkPositions: ReadonlyMap<string, HunkPositionRange | null>,
): OrderedOperation[] {
  const operationsById = new Map(operations.map((op) => [op.operationId, op]));
  const mixedHunkOperationIds = new Set<string>();
  const hunksByOp = new Map<string, HunkResolution[]>();
  for (const hunk of hunks) {
    const range = hunkPositions.get(hunk.hunkId) ?? null;
    if (hunkSpansBothKinds(hunk.operationIds, operationsById)) {
      for (const opId of hunk.operationIds) mixedHunkOperationIds.add(opId);
    }

    const resolution: HunkResolution = {
      hunkId: hunk.hunkId,
      operationIds: hunk.operationIds,
      range,
      hasDeletion: Boolean(hunk.deletedText && hunk.deletedText.length > 0),
      ...(hunk.deletedText ? { deletedText: hunk.deletedText } : {}),
    };
    for (const opId of hunk.operationIds) {
      const list = hunksByOp.get(opId);
      if (list) list.push(resolution);
      else hunksByOp.set(opId, [resolution]);
    }
  }

  const positioned: OrderedOperation[] = [];
  const unpositioned: OrderedOperation[] = [];

  for (const op of operations) {
    const raw = hunksByOp.get(op.operationId) ?? [];
    const sorted = raw.slice().sort((a, b) => rangeSortKey(a.range) - rangeSortKey(b.range));

    const firstResolved = sorted.find((h) => h.range != null);
    const shape = deriveShape(op, sorted, mixedHunkOperationIds.has(op.operationId));
    const entry: OrderedOperation = {
      operation: op,
      hunks: sorted,
      firstPos: firstResolved?.range?.from ?? Number.POSITIVE_INFINITY,
      shape,
      hasOwnDeletion: operationHasOwnDeletion(op, sorted),
      includesWriterEdits: op.kind === "agent" && mixedHunkOperationIds.has(op.operationId),
    };
    if (firstResolved) positioned.push(entry);
    else unpositioned.push(entry);
  }

  positioned.sort((a, b) => a.firstPos - b.firstPos);
  return [...positioned, ...unpositioned];
}

/** Rank order for pure-deletion hunks that share a position with an anchor. */
function rangeSortKey(range: HunkPositionRange | null): number {
  return range == null ? Number.POSITIVE_INFINITY : range.from;
}

function hunkSpansBothKinds(
  operationIds: readonly string[],
  operationsById: ReadonlyMap<string, ReviewOperation>,
): boolean {
  let sawAgent = false;
  let sawWriter = false;
  for (const opId of operationIds) {
    const op = operationsById.get(opId);
    if (op?.kind === "agent") sawAgent = true;
    if (op?.kind === "writer") sawWriter = true;
  }
  return sawAgent && sawWriter;
}

function deriveShape(
  operation: ReviewOperation,
  _hunks: readonly HunkResolution[],
  sharesMixedHunk: boolean,
): OperationShape {
  switch (operation.contribution) {
    case "added":
      return operation.kind === "writer" && sharesMixedHunk ? "mixed" : "insert";
    case "removed":
      return "delete";
    case "rewrote":
      return "replace";
    case "edited":
      return "mixed";
  }
}

function operationHasOwnDeletion(
  operation: ReviewOperation,
  _hunks: readonly HunkResolution[],
): boolean {
  return operation.contribution === "removed" || operation.contribution === "rewrote";
}

/**
 * Group entries by adjacency for the "comment queue" visual grouping — two
 * operations whose first hunks land inside the same block boundary (measured
 * by an at-block-level position resolver the caller supplies) render as
 * adjacent cards with no gap.
 *
 * The block-boundary resolver takes an absolute position and returns a stable
 * block key (e.g., the parent node's absolute start). Passing `null` returns
 * everything as one group per entry — used by tests that don't need real
 * ProseMirror geometry.
 */
export function groupAdjacentEntries(
  entries: readonly OrderedOperation[],
  blockKeyForPos: ((pos: number) => number | null) | null,
): OrderedOperation[][] {
  if (entries.length === 0) return [];
  if (!blockKeyForPos) return entries.map((entry) => [entry]);

  const groups: OrderedOperation[][] = [];
  let currentBlockKey: number | null = null;
  let currentGroup: OrderedOperation[] | null = null;
  for (const entry of entries) {
    const blockKey = Number.isFinite(entry.firstPos) ? blockKeyForPos(entry.firstPos) : null;
    if (blockKey != null && blockKey === currentBlockKey && currentGroup) {
      currentGroup.push(entry);
      continue;
    }
    currentGroup = [entry];
    groups.push(currentGroup);
    currentBlockKey = blockKey;
  }
  return groups;
}

function operationAcceptClosure(operation: ReviewOperation): string[] {
  return operation.acceptClosureOperationIds ?? [operation.operationId];
}

function operationAcceptClosureFromEntries(
  operationId: string,
  entries: readonly OrderedOperation[],
): string[] {
  const operation = entries.find((entry) => entry.operation.operationId === operationId)?.operation;
  return operation ? operationAcceptClosure(operation) : [operationId];
}

export function DraftReviewSidebar({
  editor,
  className,
  onDiscardOperation,
}: DraftReviewSidebarProps) {
  const { controller } = useDraftReview();
  const reviewDraftId = controller.inlineReview?.draftId ?? null;
  const pendingDiscardIds = controller.pendingInlineDiscardIds(reviewDraftId);
  const acceptDraft = useAcceptDraft();
  const undoAccept = useUndoDraftAccept();
  const [confirmingDiscardId, setConfirmingDiscardId] = useState<string | null>(null);
  const [confirmingAcceptId, setConfirmingAcceptId] = useState<string | null>(null);
  const [draftMessage, setDraftMessage] = useState<{ text: string; writeId?: string } | null>(null);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const pendingTimeoutsRef = useRef<Map<string, number>>(new Map());
  const latestPendingRef = useRef<{
    draftId: string | null;
    operationIds: readonly string[];
  }>({ draftId: null, operationIds: [] });

  const snapshot =
    useEditorState<SidebarSnapshot>({
      editor,
      selector: ({ editor: currentEditor }) => {
        if (!currentEditor) return EMPTY_SNAPSHOT;
        const pluginState = getInlineReviewPluginState(currentEditor.state);
        if (!pluginState?.model) {
          return { pluginState, entries: [], groups: [] };
        }
        const model = pluginState.model;
        const positions = collectHunkPositions(pluginState);
        const entries = orderOperationsForSidebar(model.operations, model.hunks, positions);
        const doc = currentEditor.state.doc;
        const groups = groupAdjacentEntries(entries, (pos) => resolveBlockKey(doc, pos));
        return { pluginState, entries, groups };
      },
      equalityFn: (a, b) => {
        if (a === b) return true;
        if (!a || !b) return false;
        return sidebarSnapshotEqual(a, b);
      },
    }) ?? EMPTY_SNAPSHOT;

  const { pluginState, entries, groups } = snapshot;
  const activeOperationId = pluginState?.activeOperationId ?? null;

  useEffect(() => {
    latestPendingRef.current = { draftId: reviewDraftId, operationIds: [...pendingDiscardIds] };
  }, [pendingDiscardIds, reviewDraftId]);

  // Card refs — used by the editor → sidebar scroll direction. When the
  // active operation changes (from any source), scroll the matching card
  // into view within the rail's own scroll container.
  const cardRefs = useRef<Map<string, HTMLElement | null>>(new Map());
  useEffect(() => {
    if (!activeOperationId) return;
    const node = cardRefs.current.get(activeOperationId);
    node?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeOperationId]);

  useEffect(() => {
    if (!reviewDraftId) return;
    const entryIds = new Set(entries.map((entry) => entry.operation.operationId));
    for (const pendingId of pendingDiscardIds) {
      if (entryIds.has(pendingId)) continue;
      window.clearTimeout(pendingTimeoutsRef.current.get(pendingId));
      pendingTimeoutsRef.current.delete(pendingId);
      controller.settleInlineDiscard(reviewDraftId, pendingId);
    }
  }, [controller, entries, pendingDiscardIds, reviewDraftId]);

  useEffect(() => {
    return () => {
      for (const timer of pendingTimeoutsRef.current.values()) window.clearTimeout(timer);
      pendingTimeoutsRef.current.clear();
      const { draftId, operationIds } = latestPendingRef.current;
      if (!draftId) return;
      for (const operationId of operationIds) {
        controller.settleInlineDiscard(draftId, operationId);
      }
    };
  }, [controller]);

  const handleCardClick = useCallback(
    (operationId: string) => {
      if (!editor || editor.isDestroyed) return;
      editor.commands.setInlineReviewActiveOperation(operationId);
      editor.commands.scrollInlineReviewOperationIntoView(operationId);
    },
    [editor],
  );

  const handleAccept = useCallback(
    async (operationId: string, confirmedClosure = false) => {
      const model = pluginState?.model;
      const inline = controller.inlineReview;
      if (!model || !inline || acceptDraft.isPending || undoAccept.isPending) return;
      setConfirmingAcceptId(null);
      setDraftMessage(null);
      acceptDraft.mutate(
        {
          projectId: controller.projectId,
          workId: controller.workId,
          documentId: inline.documentId,
          draftId: inline.draftId,
          draftRevisionToken: model.draftRevisionToken,
          operationIds: [operationId],
          confirmedClosure,
        },
        {
          onSuccess(response) {
            if (response.status === "partial_applied") {
              setDraftMessage({ text: "Applied proposal", writeId: response.writeId });
            } else if (response.status === "stale_draft") {
              setDraftMessage({ text: "Draft changed — refreshed proposals." });
            } else if (response.status === "causal_dependency") {
              setDraftMessage({ text: response.message });
            } else if (response.status === "closure_confirmation_required") {
              setConfirmingAcceptId(operationId);
            }
          },
          onError() {
            setDraftMessage({ text: "Couldn't accept. Check your connection and try again." });
          },
        },
      );
    },
    [acceptDraft, controller, pluginState?.model, undoAccept.isPending],
  );

  const handleUndoPartialAccept = useCallback(() => {
    const inline = controller.inlineReview;
    if (!inline || !draftMessage?.writeId || undoAccept.isPending) return;
    undoAccept.mutate(
      {
        projectId: controller.projectId,
        workId: controller.workId,
        documentId: inline.documentId,
        draftId: inline.draftId,
        writeId: draftMessage.writeId,
      },
      {
        onSuccess() {
          setDraftMessage({ text: "Proposal restored." });
        },
        onError() {
          setDraftMessage({ text: "Couldn't undo accept. Try again." });
        },
      },
    );
  }, [controller, draftMessage?.writeId, undoAccept]);

  const handleDiscard = useCallback(
    async (operationId: string) => {
      if (!reviewDraftId || pendingDiscardIds.size > 0) return;
      if (!controller.startInlineDiscard(reviewDraftId, operationId)) return;
      setConfirmingDiscardId(null);
      setDiscardError(null);
      try {
        if (!onDiscardOperation) throw new Error("Discard is not available yet.");
        const outcome = await onDiscardOperation(operationId);
        if (outcome.status !== "applied") {
          setDiscardError(messageForRejectOutcome(outcome));
          controller.settleInlineDiscard(reviewDraftId, operationId);
          return;
        }
        const timer = window.setTimeout(() => {
          pendingTimeoutsRef.current.delete(operationId);
          if (!controller.pendingInlineDiscardIds(reviewDraftId).has(operationId)) return;
          setDiscardError("Discard didn't stick — the draft may have been finalized.");
          controller.settleInlineDiscard(reviewDraftId, operationId);
        }, 4500);
        pendingTimeoutsRef.current.set(operationId, timer);
      } catch {
        setDiscardError("Couldn't discard. Check your connection and try again.");
        controller.settleInlineDiscard(reviewDraftId, operationId);
      }
    },
    [controller, onDiscardOperation, pendingDiscardIds, reviewDraftId],
  );

  const hasModel = pluginState?.model != null;
  const isEmptyDiff = hasModel && entries.length === 0;

  return (
    <aside
      aria-label="Draft review proposals"
      className={cn(
        // Fixed-width right rail with its own scroll region. Border on the
        // left separates it from the manuscript pane.
        "flex h-full w-72 shrink-0 flex-col border-border-subtle border-l bg-surface-subtle",
        className,
      )}
      data-draft-review-sidebar
    >
      <header className="flex items-baseline gap-2 border-border-subtle border-b bg-background px-4 py-2">
        <p className="text-meta font-semibold uppercase tracking-[0.07em] text-muted-foreground">
          <Trans>Proposals</Trans>
        </p>
        <span className="ml-auto tabular-nums text-muted-foreground text-xs">{entries.length}</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {draftMessage ? (
          <p className="mb-3 rounded-md border border-primary/25 bg-primary/10 px-3 py-2 text-primary text-xs">
            {draftMessage.text}
            {draftMessage.writeId ? (
              <button
                type="button"
                className="ml-2 font-medium underline underline-offset-2"
                onClick={handleUndoPartialAccept}
                disabled={undoAccept.isPending}
              >
                <Trans>Undo</Trans>
              </button>
            ) : null}
          </p>
        ) : null}
        {discardError ? (
          <p
            className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs"
            role="alert"
          >
            {discardError}
          </p>
        ) : null}
        {!hasModel ? (
          <SidebarStatus>
            <Trans>Loading proposals…</Trans>
          </SidebarStatus>
        ) : isEmptyDiff ? (
          <SidebarStatus>
            <Trans>No changes to review — the draft matches your manuscript.</Trans>
          </SidebarStatus>
        ) : (
          <ol className="flex flex-col gap-3">
            {groups.map((group, groupIndex) => (
              // Cards in the same passage stack with a single tight gap; the
              // outer `gap-3` above provides the between-group separation.
              // Use the first operation id as a stable key — grouping never
              // splits an operation so this is unique.
              <li
                key={group[0]?.operation.operationId ?? `group-${groupIndex}`}
                className="flex flex-col gap-1"
              >
                {group.map((entry) => (
                  <OperationCard
                    key={entry.operation.operationId}
                    ref={(node) => {
                      const map = cardRefs.current;
                      if (node) map.set(entry.operation.operationId, node);
                      else map.delete(entry.operation.operationId);
                    }}
                    entry={entry}
                    active={entry.operation.operationId === activeOperationId}
                    pending={
                      pendingDiscardIds.has(entry.operation.operationId) ||
                      acceptDraft.isPending ||
                      undoAccept.isPending
                    }
                    acceptAvailable={pendingDiscardIds.size === 0}
                    discardAvailable={Boolean(onDiscardOperation) && pendingDiscardIds.size === 0}
                    confirmingAccept={confirmingAcceptId === entry.operation.operationId}
                    confirmingDiscard={confirmingDiscardId === entry.operation.operationId}
                    needsAcceptConfirm={operationAcceptClosure(entry.operation).length > 1}
                    needsDiscardConfirm={operationRejectIsMixed(entry.operation, {
                      includesWriterEdits: entry.includesWriterEdits,
                    })}
                    onSelect={() => handleCardClick(entry.operation.operationId)}
                    onConfirmAccept={() => setConfirmingAcceptId(entry.operation.operationId)}
                    onCancelAccept={() => setConfirmingAcceptId(null)}
                    onAccept={() =>
                      handleAccept(
                        entry.operation.operationId,
                        confirmingAcceptId === entry.operation.operationId,
                      )
                    }
                    onConfirmDiscard={() => setConfirmingDiscardId(entry.operation.operationId)}
                    onCancelDiscard={() => setConfirmingDiscardId(null)}
                    onDiscard={() => handleDiscard(entry.operation.operationId)}
                  />
                ))}
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}

type OperationCardProps = {
  entry: OrderedOperation;
  active: boolean;
  pending: boolean;
  acceptAvailable: boolean;
  discardAvailable: boolean;
  confirmingAccept: boolean;
  confirmingDiscard: boolean;
  needsAcceptConfirm: boolean;
  needsDiscardConfirm: boolean;
  onSelect: () => void;
  onConfirmAccept: () => void;
  onCancelAccept: () => void;
  onAccept: () => void;
  onConfirmDiscard: () => void;
  onCancelDiscard: () => void;
  onDiscard: () => void;
  ref?: (node: HTMLElement | null) => void;
};

function OperationCard({
  entry,
  active,
  pending,
  acceptAvailable,
  discardAvailable,
  confirmingAccept,
  confirmingDiscard,
  needsAcceptConfirm,
  needsDiscardConfirm,
  onSelect,
  onConfirmAccept,
  onCancelAccept,
  onAccept,
  onConfirmDiscard,
  onCancelDiscard,
  onDiscard,
  ref,
}: OperationCardProps) {
  const isWriter = entry.operation.kind === "writer";
  const title = titleForOperation(entry.operation, entry.shape);
  const detail = detailForOperation(entry);
  const turnRef = shortActorRef(entry.operation);

  return (
    <div
      ref={ref}
      className={cn(
        // Card shell: full border, no side stripe, subtle shadow, hover
        // lifts the border. Selected state uses the primary color as a
        // ring on the border so AI and writer accents stay legible.
        "surface-card rounded-md border border-border-subtle p-2.5 shadow-xs transition-[border-color,box-shadow] duration-150",
        active && "border-primary ring-1 ring-primary/40",
        !active && "hover:border-border",
      )}
      data-op-kind={isWriter ? "writer" : "agent"}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className="focus-ring flex w-full flex-col items-start gap-1 rounded-sm text-left"
      >
        <div className="flex w-full items-center gap-1.5">
          <AttributionBadge kind={isWriter ? "writer" : "agent"} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
            {title}
          </span>
        </div>
        {detail ? (
          <p className="line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">
            {detail}
            {entry.operation.hunkCount > 1 ? (
              <>
                <span className="mx-1 text-muted-foreground/70" aria-hidden>
                  ·
                </span>
                <span className="text-primary">
                  <Trans>{entry.operation.hunkCount} regions</Trans>
                </span>
              </>
            ) : null}
          </p>
        ) : entry.operation.hunkCount > 1 ? (
          <p className="text-[11.5px] text-primary">
            <Trans>{entry.operation.hunkCount} regions</Trans>
          </p>
        ) : null}
        {entry.includesWriterEdits ? (
          <p className="text-[11px] font-medium text-[color:var(--color-gold)]">
            <Trans>Includes your edits</Trans>
          </p>
        ) : null}
      </button>
      {confirmingAccept ? (
        <div className="mt-2 rounded-sm border border-primary/25 bg-primary/10 p-2">
          <p className="text-[11px] text-foreground">
            <Trans>This also accepts linked changes in this passage.</Trans>
          </p>
          <div className="mt-2 flex items-center justify-end gap-1.5">
            <Button type="button" variant="ghost" size="xs" onClick={onCancelAccept}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="button" variant="secondary" size="xs" onClick={onAccept}>
              <Trans>Accept</Trans>
            </Button>
          </div>
        </div>
      ) : confirmingDiscard ? (
        <div className="mt-2 rounded-sm border border-[color:var(--color-review-writer-border)] bg-[color:var(--color-review-writer-tint)] p-2">
          <p className="text-[11px] text-foreground">
            <Trans>This also removes your edits in this passage.</Trans>
          </p>
          <div className="mt-2 flex items-center justify-end gap-1.5">
            <Button type="button" variant="ghost" size="xs" onClick={onCancelDiscard}>
              <Trans>Keep</Trans>
            </Button>
            <Button type="button" variant="destructive" size="xs" onClick={onDiscard}>
              <Trans>Discard</Trans>
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-1.5 flex items-center justify-between">
          {turnRef ? (
            <span className="font-mono text-[10.5px] text-muted-foreground/80">{turnRef}</span>
          ) : (
            <span aria-hidden />
          )}
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={needsAcceptConfirm ? onConfirmAccept : onAccept}
              disabled={pending || !acceptAvailable}
              className="h-6 px-1.5 text-[11px] text-muted-foreground hover:bg-primary/10 hover:text-primary"
            >
              {pending ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
              <Trans>Accept</Trans>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={needsDiscardConfirm ? onConfirmDiscard : onDiscard}
              disabled={pending || !discardAvailable}
              // Quiet-destructive: muted at rest, destructive on hover — never
              // peer-weights with the card title.
              className="h-6 px-1.5 text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <Trans>Discard</Trans>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AttributionBadge({ kind }: { kind: "agent" | "writer" }) {
  // Uses the app's existing `status-pill` shape so proposal cards read as
  // kin to the entry banner and the applied/discarded status-pills — the
  // review-added / review-writer tints keep it recognisable at a glance
  // without inventing a fifth badge shape.
  return (
    <span
      className={cn(
        "status-pill shrink-0",
        kind === "agent"
          ? "bg-[color:var(--color-review-added-tint)] text-primary"
          : "bg-[color:var(--color-review-writer-tint)] text-[color:var(--color-gold)]",
      )}
    >
      {kind === "agent" ? <Trans>AI</Trans> : <Trans>You</Trans>}
    </span>
  );
}

function SidebarStatus({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-border-subtle border-dashed bg-background px-3 py-4 text-center text-muted-foreground text-xs">
      {children}
    </p>
  );
}

/**
 * Honest title derived from the server-computed classification. Writer
 * variants are narrated in first person so the eye can distinguish them at
 * a glance. Rename is a rewrite where the same span is repeated across
 * regions — the server surfaces it as its own class because it matters.
 */
// Titles are attribution-neutral: the adjacent AttributionBadge already says
// AI/You, so a first-person title would read "You You added text".
function titleForOperation(
  operation: ReviewOperation,
  shape: OrderedOperation["shape"],
): React.ReactNode {
  switch (operation.classification) {
    case "rename":
      return <Trans>Renamed text</Trans>;
    case "addition":
      return <Trans>Added text</Trans>;
    case "removal":
      return <Trans>Removed text</Trans>;
    case "rewrite":
      return <Trans>Rewrote passage</Trans>;
    default:
      // Unknown classification — fall back to the shape-derived label so
      // we always show something honest.
      return shape === "insert" ? (
        <Trans>Added text</Trans>
      ) : shape === "delete" ? (
        <Trans>Removed text</Trans>
      ) : (
        <Trans>Edited passage</Trans>
      );
  }
}

/**
 * The detail line renders the server-provided excerpts (already truncated to
 * ~60 chars at word boundaries) as `"before" → "after"`, or a single-sided
 * fragment when only one excerpt is present. Curly quotes so the eye reads
 * these as prose fragments, not code.
 */
function detailForOperation(entry: OrderedOperation): React.ReactNode {
  const { beforeExcerpt, afterExcerpt } = entry.operation;
  const before = beforeExcerpt?.trim() || null;
  const after = afterExcerpt?.trim() || null;

  if (before && after) {
    return (
      <>
        <Quoted>{before}</Quoted>
        <span className="mx-1 text-muted-foreground/70" aria-hidden>
          →
        </span>
        <Quoted>{after}</Quoted>
      </>
    );
  }
  if (after) return <Quoted>{after}</Quoted>;
  if (before) {
    return (
      <s className="text-muted-foreground/85">
        <Quoted>{before}</Quoted>
      </s>
    );
  }
  return null;
}

function Quoted({ children }: { children: React.ReactNode }) {
  return (
    <span>
      <span aria-hidden>“</span>
      {children}
      <span aria-hidden>”</span>
    </span>
  );
}

/**
 * Short, honest actor ref for the card footer. Agents get the last 6 chars
 * of the actor turn id (`turn:…3f9a2c`) — stable across renders, non-faked;
 * writer ops that don't carry a turn id fall back to `area group`.
 */
function shortActorRef(operation: ReviewOperation): string | null {
  if (operation.kind === "writer") return "area group";
  const turnId = operation.actorTurnId;
  if (!turnId) return null;
  const suffix = turnId.length > 6 ? turnId.slice(-6) : turnId;
  return `turn:${suffix}`;
}

/**
 * Return a stable per-block key for grouping adjacent proposal cards.
 * Two operations whose first hunk resolves inside the same top-level block
 * (same paragraph, heading, etc.) share this key and render as one visual
 * stack — the "comment queue per passage" affordance the mock calls for.
 * Returns `null` when the position is out of range or unblockable.
 */
function resolveBlockKey(doc: PMNode, pos: number): number | null {
  if (!Number.isFinite(pos) || pos < 0 || pos > doc.content.size) return null;
  try {
    const $pos = doc.resolve(pos);
    if ($pos.depth === 0) return null;
    return $pos.before(1);
  } catch {
    return null;
  }
}

function collectHunkPositions(
  pluginState: InlineReviewPluginState,
): ReadonlyMap<string, HunkPositionRange | null> {
  const map = new Map<string, HunkPositionRange | null>();
  const model = pluginState.model;
  if (!model) return map;

  // Walk the decoration set to find each hunk's absolute position. The
  // plugin already places these; the sidebar reuses them so it doesn't have
  // to re-decode Y.RelativePosition itself.
  const decorationList = pluginState.decorations.find();
  const decByHunk = new Map<string, { from: number; to: number }>();
  for (const dec of decorationList) {
    const spec = dec.spec as Record<string, unknown> | undefined;
    const hunkId = spec?.["data-review-hunk"];
    if (typeof hunkId !== "string") continue;
    // Prefer inline range over widget position if both are present for the
    // same hunk (a replace produces both — the inline range carries the
    // insertion span we want to scroll to).
    const existing = decByHunk.get(hunkId);
    if (existing && existing.to > existing.from) continue;
    decByHunk.set(hunkId, { from: dec.from, to: dec.to });
  }

  for (const hunk of model.hunks) {
    const dec = decByHunk.get(hunk.hunkId);
    if (!dec) {
      map.set(hunk.hunkId, null);
      continue;
    }
    map.set(hunk.hunkId, {
      from: dec.from,
      to: dec.to,
      hasDeletion: Boolean(hunk.deletedText && hunk.deletedText.length > 0),
    });
  }
  return map;
}

function sidebarSnapshotEqual(a: SidebarSnapshot, b: SidebarSnapshot): boolean {
  if (a.pluginState === b.pluginState && a.entries === b.entries) return true;
  if (a.pluginState?.model !== b.pluginState?.model) return false;
  if (a.pluginState?.activeOperationId !== b.pluginState?.activeOperationId) return false;
  if (a.entries.length !== b.entries.length) return false;
  for (let i = 0; i < a.entries.length; i += 1) {
    const ae = a.entries[i];
    const be = b.entries[i];
    if (!ae || !be) return false;
    if (ae.operation.operationId !== be.operation.operationId) return false;
    if (ae.firstPos !== be.firstPos) return false;
    if (ae.shape !== be.shape) return false;
    if (ae.hasOwnDeletion !== be.hasOwnDeletion) return false;
    if (ae.includesWriterEdits !== be.includesWriterEdits) return false;
  }
  return true;
}

function messageForRejectOutcome(outcome: InlineReviewRejectOutcome): string {
  switch (outcome.status) {
    case "stale":
      return "Couldn't discard — your latest edits are still syncing. Try again in a moment.";
    case "finalized":
      return "Couldn't discard — this draft may have been finalized.";
    case "offline":
      return "Couldn't discard. Check your connection and try again.";
    default:
      return "Couldn't discard. Try again.";
  }
}
