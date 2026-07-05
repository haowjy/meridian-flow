/**
 * ReviewOperationCard — one change card in the dock Changes view.
 *
 * Renders a quiet verb (Rewrote / Added / Removed) over the intended change
 * itself (the editor's inline-review tint tokens, so a card reads like the mark
 * it points at), plus the hover-revealed Apply / Discard verb cluster. The card
 * body is focus/scroll only; the verbs are the sole mutating targets and fence
 * their own propagation. The needs-confirm paths (accept closure, discard with
 * dependents) collapse onto the same verb slot as a quiet second step — no
 * modal, no browser confirm.
 */
import { Trans } from "@lingui/react/macro";
import type { ReviewOperation } from "@meridian/contracts/drafts";
import type { ReactNode } from "react";
import type { InlineReviewModel } from "@/core/editor/extensions/inline-review";
import { operationRejectNeedsConfirm } from "@/core/editor/inline-review-runtime";
import type { DraftReviewController } from "@/features/chat/useDraftReviewController";
import { cn } from "@/lib/utils";
import type { OperationChangeText } from "./operation-change-text";

export function ReviewOperationCard({
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
 * in-flight or holding a confirm so its state can't hide. Verbs disable while
 * ANY review disposition is in flight (`controller.isDisposing`) so the writer
 * can't stack overlapping accepts/discards; the active card keeps its visible
 * pending treatment. Both needs-confirm paths collapse onto the same slot: a
 * quiet prompt + a confirm verb + a way back out.
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
  // This card is the one running a disposition — drives the visible pending
  // treatment (stays revealed); the disable itself is global (`isDisposing`).
  const activeOnThisCard =
    controller.acceptingOperationId === operationId ||
    controller.pendingInlineDiscardIds(draftId).has(operationId);
  const disabled = controller.isDisposing;
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
          disabled={disabled}
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
          disabled={disabled}
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
        activeOnThisCard
          ? "opacity-100"
          : "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
      )}
    >
      {/* A change that no longer places has no Apply — only Discard clears it. */}
      {cannotPlace ? null : (
        <VerbButton
          tone="primary"
          disabled={disabled}
          onClick={() => controller.acceptOperation(operationId, model)}
        >
          <Trans>Apply</Trans>
        </VerbButton>
      )}
      <VerbButton
        tone="muted"
        disabled={disabled}
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

export function VerbButton({
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
