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
 * visual grammar as the manuscript. Clicking a card body highlights and scrolls
 * the matching span through the controller (`focusReviewOperation`).
 *
 * Each card also carries hover-revealed **Apply / Discard** verbs — the writer
 * settles changes one at a time from the dock. The verbs are the ONLY mutating
 * targets on the card (they stop propagation so a verb click never also
 * focuses/scrolls). Apply routes the closure-aware accept mutation; Discard
 * reverses one operation via a journal-inverse Yjs update. The needs-confirm
 * paths (accept closure, discard-with-dependents) surface as a quiet inline
 * second step on the same slot — no modal, no browser confirm.
 */
import { Trans } from "@lingui/react/macro";
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import { type ReactNode, useMemo, useState } from "react";
import { useDraftPreview } from "@/client/query/useDraftPreview";
import {
  buildInlineReviewModel,
  type InlineReviewModel,
} from "@/core/editor/extensions/inline-review";
import { operationRejectNeedsConfirm } from "@/core/editor/inline-review-runtime";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { type DockRow, dockRows } from "@/features/chat/docked-drafts";
import { DraftStatsLabel, draftStats } from "@/features/chat/draft-stats";
import { useAiDraftLauncher } from "@/features/chat/useAiDraftLauncher";
import type { DraftReviewController } from "@/features/chat/useDraftReviewController";
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
        <p className="px-2 py-1.5 text-caption text-muted-foreground">
          <Trans>No pending changes.</Trans>
        </p>
      ) : (
        rows.map((row) => (
          <ChangesDocumentGroup
            key={row.documentId}
            row={row}
            controller={controller}
            active={row.documentId === inlineReview?.documentId}
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
          />
        ))
      )}
    </div>
  );
}

type ActivePreview = {
  operations: ReviewOperation[];
  hunks: ReviewHunk[];
  liveRevisionToken: number;
  draftRevisionToken: number;
};

/**
 * One document group: the header row Reviews it (the lane's whole-row target
 * grammar). When this document is under review, its operations render as change
 * cards beneath the header.
 *
 * Rail grammar throughout (matches ContextSidebar's DocumentRow): transparent
 * rows, `text-sm` names, `text-caption` secondary in the muted-foreground ramp,
 * `sidebar-accent` tints. The stats label sizes itself from context, so the
 * caption wrapper here is what keeps `+2,033` quieter than the document name.
 */
function ChangesDocumentGroup({
  row,
  controller,
  active,
  preview,
  onReview,
}: {
  row: DockRow;
  controller: DraftReviewController;
  active: boolean;
  preview: ActivePreview | null;
  onReview: () => void;
}) {
  const name = row.documentName ?? row.documentId;
  const stats = draftStats(row.draft);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onReview}
        className={cn(
          "group focus-ring flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
          active ? "bg-sidebar-accent/50" : "hover:bg-sidebar-accent/40",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{name}</span>
        {stats ? (
          <span className="shrink-0 text-caption">
            <DraftStatsLabel stats={stats} wordsSuffix={false} />
          </span>
        ) : null}
        {/* The doc under review has no Review left to offer — the verb only
            appears on rows where it still does something. */}
        {!active ? (
          <span className="shrink-0 text-caption font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <Trans>Review</Trans>
          </span>
        ) : null}
      </button>
      {preview && preview.operations.length > 0 ? (
        <ReviewOperationCards
          preview={preview}
          controller={controller}
          draftId={row.draft.draftId}
        />
      ) : null}
    </div>
  );
}

/**
 * Operation cards for the document under review. Local active state is the
 * click echo — clicking a card body scrolls the manuscript and rings the card;
 * the editor is the source of truth for the span, this is just the index into
 * it. One card per operation the preview hands us — combining dependent regions
 * into a unit is upstream, this view never merges or splits.
 *
 * The inline-review model (anchors decoded) is built once here and threaded to
 * every card's Apply, which needs the operation's accept-closure ids and the
 * live revision token the accept confirms against.
 */
function ReviewOperationCards({
  preview,
  controller,
  draftId,
}: {
  preview: ActivePreview;
  controller: DraftReviewController;
  draftId: string;
}) {
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);
  const model = useMemo(
    () =>
      buildInlineReviewModel({
        liveRevisionToken: preview.liveRevisionToken,
        draftRevisionToken: preview.draftRevisionToken,
        operations: preview.operations,
        hunks: preview.hunks,
      }),
    [preview],
  );
  // One review session runs one accept/discard message at a time, so a single
  // quiet line under the cards is enough — no per-card message plumbing.
  const message = controller.inlineReviewMessage ?? messageFromDiscardError(controller);
  return (
    <div className="flex flex-col gap-1.5 pb-1.5 pl-2">
      {preview.operations.map((operation) => (
        <ReviewOperationCard
          key={operation.operationId}
          operation={operation}
          model={model}
          controller={controller}
          draftId={draftId}
          change={operationChangeText(operation, preview.hunks)}
          active={activeOperationId === operation.operationId}
          onFocus={() => {
            setActiveOperationId(operation.operationId);
            controller.focusReviewOperation(operation.operationId);
          }}
        />
      ))}
      {message ? (
        <p
          className={cn(
            "px-1 text-caption",
            message.tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
          role={message.tone === "error" ? "alert" : undefined}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

function ReviewOperationCard({
  operation,
  model,
  controller,
  draftId,
  change,
  active,
  onFocus,
}: {
  operation: ReviewOperation;
  model: InlineReviewModel;
  controller: DraftReviewController;
  draftId: string;
  change: OperationChangeText;
  active: boolean;
  onFocus: () => void;
}) {
  return (
    // A `div[role=button]` (not a `<button>`) so the mutating Apply/Discard
    // buttons can nest inside without an invalid button-in-button. The body
    // click is focus/scroll only; the verbs fence propagation themselves.
    // biome-ignore lint/a11y/useSemanticElements: a real <button> can't nest the Apply/Discard buttons.
    <div
      role="button"
      tabIndex={0}
      onClick={onFocus}
      onKeyDown={(event) => {
        // Only the card itself drives focus/scroll — a verb button's own Enter
        // key press bubbles here and must not double-fire.
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onFocus();
        }
      }}
      className={cn(
        // Full-border card on the RAIL surface — transparent body + sidebar
        // tints, not `bg-card` (white main-surface cards look pasted onto the
        // dock). Active is the primary border alone; the editor's pulse carries
        // the focus feedback. Border color is one class per state on purpose:
        // `cn`/tailwind-merge can't dedupe the custom `border-subtle` color, so
        // stacking it with `border-primary` would leave the wrong one winning.
        "group focus-ring flex w-full flex-col gap-1 rounded-md border p-2 text-left transition-colors duration-150",
        active
          ? "border-primary"
          : "border-border-subtle hover:border-border hover:bg-sidebar-accent/30",
      )}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-caption font-medium text-muted-foreground">
          <OperationVerb classification={operation.classification} />
        </span>
        <CardVerbs operation={operation} model={model} controller={controller} draftId={draftId} />
      </div>
      <OperationChange classification={operation.classification} change={change} />
    </div>
  );
}

/**
 * The per-card Apply / Discard cluster. Reveals on card hover/focus (matching
 * the doc row's hover-Review verb), but stays visible while this card is
 * in-flight or holding a confirm so its state can't hide. Both needs-confirm
 * paths collapse onto the same slot: a quiet prompt + a confirm verb + a way
 * back out.
 */
function CardVerbs({
  operation,
  model,
  controller,
  draftId,
}: {
  operation: ReviewOperation;
  model: InlineReviewModel;
  controller: DraftReviewController;
  draftId: string;
}) {
  const operationId = operation.operationId;
  const pending =
    controller.acceptingOperationId === operationId ||
    controller.pendingInlineDiscardIds(draftId).has(operationId);
  const cannotPlace = controller.cannotPlaceInlineOperationIds(draftId).has(operationId);
  const confirmingAccept = controller.confirmingAcceptOperationId === operationId;
  const confirmingDiscard = controller.confirmingDiscardOperationId === operationId;

  // Apply confirmation is server-driven (a closure/overlap response), so this
  // slot only *renders* the confirm — the click re-runs acceptOperation, which
  // resends with the confirmed closure/overlap tokens.
  if (confirmingAccept) {
    return (
      <ConfirmCluster>
        <span className="text-caption text-muted-foreground">
          <Trans>Apply related changes?</Trans>
        </span>
        <VerbButton
          tone="primary"
          disabled={pending}
          onClick={() => controller.acceptOperation(operationId, model)}
        >
          <Trans>Apply</Trans>
        </VerbButton>
        <VerbDot />
        <VerbButton tone="muted" onClick={() => controller.cancelAcceptOperation()}>
          <Trans>Cancel</Trans>
        </VerbButton>
      </ConfirmCluster>
    );
  }

  if (confirmingDiscard) {
    return (
      <ConfirmCluster>
        <span className="text-caption text-muted-foreground">
          <Trans>Discard this change?</Trans>
        </span>
        <VerbButton
          tone="strong"
          disabled={pending}
          onClick={() => void controller.discardOperation(operationId)}
        >
          <Trans>Discard</Trans>
        </VerbButton>
        <VerbDot />
        <VerbButton tone="muted" onClick={() => controller.cancelDiscardOperation()}>
          <Trans>Keep</Trans>
        </VerbButton>
      </ConfirmCluster>
    );
  }

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2",
        pending
          ? "opacity-100"
          : "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
      )}
    >
      {/* A change that no longer places has no Apply — only Discard clears it. */}
      {cannotPlace ? null : (
        <VerbButton
          tone="primary"
          disabled={pending}
          onClick={() => controller.acceptOperation(operationId, model)}
        >
          <Trans>Apply</Trans>
        </VerbButton>
      )}
      <VerbButton
        tone="muted"
        disabled={pending}
        onClick={() => {
          // Discarding a change with dependents needs a second step; a lone
          // change discards straight away.
          if (operationRejectNeedsConfirm(operation)) {
            controller.confirmDiscardOperation(operationId);
          } else {
            void controller.discardOperation(operationId);
          }
        }}
      >
        <Trans>Discard</Trans>
      </VerbButton>
    </div>
  );
}

function ConfirmCluster({ children }: { children: ReactNode }) {
  return <div className="flex shrink-0 flex-wrap items-center gap-1.5">{children}</div>;
}

function VerbDot() {
  return (
    <span aria-hidden className="text-muted-foreground/50">
      ·
    </span>
  );
}

const VERB_TONE = {
  primary: "text-primary",
  muted: "text-muted-foreground hover:text-foreground",
  strong: "text-foreground",
} as const;

function VerbButton({
  tone,
  disabled,
  onClick,
  children,
}: {
  tone: keyof typeof VERB_TONE;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      // The verbs are the only mutating targets — a verb click must not also
      // trigger the card body's focus/scroll.
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "focus-ring shrink-0 whitespace-nowrap rounded-sm text-caption font-medium transition-colors disabled:opacity-50",
        VERB_TONE[tone],
      )}
    >
      {children}
    </button>
  );
}

function messageFromDiscardError(
  controller: DraftReviewController,
): { text: string; tone: "error" } | null {
  return controller.inlineDiscardError
    ? { text: controller.inlineDiscardError, tone: "error" }
    : null;
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
 * The card body: the intended change, styled per classification, carrying the
 * editor's added/removed tint tokens so a card reads like the mark it points
 * at — additions in the added tint, removals in the removed tint + struck,
 * rewrites stacking removed over added. Empty change → verb-only card.
 */
function OperationChange({
  classification,
  change,
}: {
  classification: ReviewOperation["classification"];
  change: OperationChangeText;
}) {
  if (classification === "addition") {
    return change.added ? <TintedChangeText tone="added" text={change.added} clamp={3} /> : null;
  }
  if (classification === "removal") {
    return change.removed ? (
      <TintedChangeText tone="removed" text={change.removed} clamp={3} />
    ) : null;
  }
  // rewrite / rename: removed → added, each clamped tighter so the pair fits.
  if (!change.removed && !change.added) return null;
  return (
    <div className="flex flex-col gap-1">
      {change.removed ? <TintedChangeText tone="removed" text={change.removed} clamp={2} /> : null}
      {change.added ? <TintedChangeText tone="added" text={change.added} clamp={2} /> : null}
    </div>
  );
}

/**
 * One tinted change line. Reuses the editor's inline-review tint tokens
 * (`--color-review-{added,removed}-*`) so added/removed text reads the same
 * here as in the manuscript; `box-decoration-clone` keeps the tint hugging
 * wrapped lines like the editor mark does.
 */
function TintedChangeText({
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
