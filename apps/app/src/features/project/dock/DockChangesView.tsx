/**
 * DockChangesView — the dock's work-scoped Changes view.
 *
 * Lists every document with pending AI changes for the Work, one row each:
 * name + `+N −N` word totals + a hover-revealed Review verb. Whole-row click
 * is Review, routed through the SAME launcher the composer DraftDock uses
 * (`useAiDraftLauncher`), so opening review and switching the dock to Changes
 * stay one gesture with one code path.
 *
 * The document CURRENTLY under inline review expands to operation CARDS beneath
 * its header: a quiet verb (Rewrote / Added / Removed) over the intended change
 * itself — incoming text for additions, removed text for removals, before→after
 * for rewrites. Card bodies read the live preview (`useDraftPreview`) and reuse
 * the editor's inline-review tint tokens so added/removed text carries the same
 * visual grammar as the manuscript. Clicking a card highlights and scrolls the
 * matching span through the controller (`focusReviewOperation`) — the review
 * surface owns the editor handle; this view only names the operation and clamps
 * its change to a few lines, the editor holds the full change. Per-op word
 * deltas are not on the wire yet, so no `+N −N` is invented here.
 */
import { Trans } from "@lingui/react/macro";
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import { useMemo, useState } from "react";
import { useDraftPreview } from "@/client/query/useDraftPreview";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { type DockRow, dockRows } from "@/features/chat/docked-drafts";
import { DraftStatsLabel, draftStats } from "@/features/chat/draft-stats";
import { useAiDraftLauncher } from "@/features/chat/useAiDraftLauncher";
import { cn } from "@/lib/utils";

export function DockChangesView({ className }: { className?: string }) {
  const { groups, nowMs, controller } = useDraftReview();
  const { openAiDraft } = useAiDraftLauncher();

  const rows = useMemo(
    () => dockRows(groups, nowMs).filter((row) => row.state === "pending"),
    [groups, nowMs],
  );

  const inlineReview = controller.inlineReview;
  const preview = useDraftPreview(
    controller.projectId,
    controller.workId,
    inlineReview?.documentId ?? null,
    inlineReview?.draftId ?? null,
    { enabled: Boolean(inlineReview) },
  );
  const activePreview =
    preview.preview?.status === "active" && preview.preview.inlineModelPresent
      ? preview.preview
      : null;

  return (
    <div className={cn("flex min-h-0 flex-col overflow-y-auto px-2 py-2", className)}>
      {rows.length === 0 ? (
        <p className="px-2 py-1.5 text-caption text-ink-muted">
          <Trans>No pending changes.</Trans>
        </p>
      ) : (
        rows.map((row) => (
          <ChangesDocumentGroup
            key={row.documentId}
            row={row}
            preview={row.documentId === inlineReview?.documentId ? activePreview : null}
            onReview={() =>
              openAiDraft(
                {
                  documentId: row.documentId,
                  contextPath: row.contextPath ?? undefined,
                  documentName: row.documentName ?? undefined,
                },
                row.draft.draftId,
              )
            }
            onFocusOperation={controller.focusReviewOperation}
          />
        ))
      )}
    </div>
  );
}

type ActivePreview = { operations: ReviewOperation[]; hunks: ReviewHunk[] };

/**
 * One document group: the header row Reviews it (the lane's whole-row target
 * grammar). When this document is under review, its operations render as change
 * cards beneath the header.
 */
function ChangesDocumentGroup({
  row,
  preview,
  onReview,
  onFocusOperation,
}: {
  row: DockRow;
  preview: ActivePreview | null;
  onReview: () => void;
  onFocusOperation: (operationId: string) => void;
}) {
  const name = row.documentName ?? row.documentId;
  const stats = draftStats(row.draft);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onReview}
        className="group focus-ring flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent/40"
      >
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{name}</span>
        {stats ? (
          <span className="shrink-0">
            <DraftStatsLabel stats={stats} wordsSuffix={false} />
          </span>
        ) : null}
        <span className="shrink-0 text-caption font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <Trans>Review</Trans>
        </span>
      </button>
      {preview && preview.operations.length > 0 ? (
        <ReviewOperationCards preview={preview} onFocusOperation={onFocusOperation} />
      ) : null}
    </div>
  );
}

/**
 * Operation cards for the document under review. Local active state is the
 * click echo — clicking scrolls the manuscript and rings the card; the editor
 * is the source of truth for the span, this is just the index into it. One card
 * per operation the preview hands us — combining dependent regions into a unit
 * is upstream, this view never merges or splits.
 */
function ReviewOperationCards({
  preview,
  onFocusOperation,
}: {
  preview: ActivePreview;
  onFocusOperation: (operationId: string) => void;
}) {
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1.5 pb-1.5 pl-3">
      {preview.operations.map((operation) => (
        <ReviewOperationCard
          key={operation.operationId}
          operation={operation}
          change={operationChangeText(operation, preview.hunks)}
          active={activeOperationId === operation.operationId}
          onClick={() => {
            setActiveOperationId(operation.operationId);
            onFocusOperation(operation.operationId);
          }}
        />
      ))}
    </div>
  );
}

function ReviewOperationCard({
  operation,
  change,
  active,
  onClick,
}: {
  operation: ReviewOperation;
  change: OperationChangeText;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // Full-border card on the card surface — no side stripe. Active gets a
        // primary border + ring; idle lifts its subtle border on hover as the
        // "click me" cue. Border color is one class per state on purpose:
        // `cn`/tailwind-merge can't dedupe the custom `border-subtle` color, so
        // stacking it with `border-primary` would leave the wrong one winning.
        "focus-ring flex w-full flex-col gap-1 rounded-md border bg-card p-2 text-left transition-[border-color] duration-150",
        active
          ? "border-primary ring-1 ring-primary/40"
          : "border-border-subtle hover:border-border",
      )}
    >
      <span className="text-caption font-medium text-ink-muted">
        <OperationVerb classification={operation.classification} />
      </span>
      <OperationChange classification={operation.classification} change={change} />
    </button>
  );
}

/** Canon quiet verb from the server classification — rename collapses to Rewrote. */
function OperationVerb({ classification }: { classification: ReviewOperation["classification"] }) {
  switch (classification) {
    case "addition":
      return <Trans>Added</Trans>;
    case "removal":
      return <Trans>Removed</Trans>;
    default:
      return <Trans>Rewrote</Trans>;
  }
}

/**
 * The card body: the intended change, styled per classification. Additions show
 * the incoming text; removals show the removed text; rewrites stack removed over
 * added as a mini-diff. Empty change → verb-only card.
 */
function OperationChange({
  classification,
  change,
}: {
  classification: ReviewOperation["classification"];
  change: OperationChangeText;
}) {
  if (classification === "addition") {
    return change.added ? <ChangeLine tone="added" text={change.added} clamp={3} /> : null;
  }
  if (classification === "removal") {
    return change.removed ? <ChangeLine tone="removed" text={change.removed} clamp={3} /> : null;
  }
  // rewrite / rename: removed → added, each clamped tighter so the pair fits.
  if (!change.removed && !change.added) return null;
  return (
    <div className="flex flex-col gap-1">
      {change.removed ? <ChangeLine tone="removed" text={change.removed} clamp={2} /> : null}
      {change.added ? <ChangeLine tone="added" text={change.added} clamp={2} /> : null}
    </div>
  );
}

/**
 * One tinted change fragment. Reuses the editor's inline-review tint tokens
 * (`--color-review-{added,removed}-*`) so added/removed text reads the same
 * here as in the manuscript. The tint spans wrapped lines like the editor mark;
 * the surrounding paragraph clamps the whole fragment to a few lines.
 */
function ChangeLine({
  tone,
  text,
  clamp,
}: {
  tone: "added" | "removed";
  text: string;
  clamp: 2 | 3;
}) {
  return (
    <p
      className={cn(
        "whitespace-pre-wrap break-words text-caption leading-snug",
        clamp === 2 ? "line-clamp-2" : "line-clamp-3",
      )}
    >
      <span
        className={cn(
          "rounded-[0.125rem] box-decoration-clone px-0.5",
          tone === "added"
            ? "bg-[color:var(--color-review-added-tint)] text-foreground"
            : "bg-[color:var(--color-review-removed-tint)] text-[color:var(--color-review-removed-foreground)] line-through",
        )}
      >
        {text}
      </span>
    </p>
  );
}

type OperationChangeText = { removed: string | null; added: string | null };

/**
 * The change text for one operation, richest-first. Removed text and whole
 * removed/inserted blocks come from the hunks (`deletedText`, block displays),
 * which carry the full passage; the operation's word-bound excerpts are the
 * fallback. Inline INSERTED text is not on the wire per operation — it lives in
 * the preview document positioned by Yjs anchors the dock can't resolve — so the
 * added side of a text edit stays excerpt-only (`afterExcerpt`).
 */
export function operationChangeText(
  operation: ReviewOperation,
  hunks: ReviewHunk[],
): OperationChangeText {
  const removedParts: string[] = [];
  const addedBlockParts: string[] = [];
  for (const hunk of hunks) {
    if (!hunk.operationIds.includes(operation.operationId)) continue;
    if (hunk.kind === "text") {
      if (hunk.deletedText) removedParts.push(hunk.deletedText);
    } else {
      // Structural block displays (horizontal_rule → "───") are decoration,
      // not prose: a card body of nothing but separators reads as broken, so
      // only displays with actual words count as content here.
      if (hunk.deletedBlock && hasProse(hunk.deletedBlock.display)) {
        removedParts.push(hunk.deletedBlock.display);
      }
      if (hunk.insertedBlock && hasProse(hunk.insertedBlock.display)) {
        addedBlockParts.push(hunk.insertedBlock.display);
      }
    }
  }
  return {
    removed: joinTrim(removedParts) ?? trimToNull(operation.beforeExcerpt),
    added: joinTrim(addedBlockParts) ?? trimToNull(operation.afterExcerpt),
  };
}

function hasProse(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function joinTrim(parts: string[]): string | null {
  return trimToNull(parts.join("\n"));
}

function trimToNull(text: string | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}
