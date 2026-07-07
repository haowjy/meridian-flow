/**
 * ReviewOperationCard — one proposal card in the dock Changes view.
 *
 * Closure=card (spec §5.3): each card renders ONE closure class — a quiet verb
 * (Rewrote / Added / Removed, or `Merged` for a CRDT merge artifact, or
 * `New document` for a draft-created doc) over the intended change, plus a
 * single Apply/Create and a single Discard. Contributing turns are attributed
 * on the card and writer edits that joined the class show an informational
 * "Includes your edits" badge. There is NO dependency prompt anywhere: applying
 * or discarding acts on the whole class at once — the writer never learns the
 * internal write structure.
 *
 * The card body is focus/scroll only; the verbs are the sole mutating targets
 * and fence their own propagation.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { GitMerge } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { InlineReviewModel } from "@/core/editor/extensions/inline-review";
import type { DraftReviewController } from "@/features/chat/useDraftReviewController";
import { cn } from "@/lib/utils";
import type { ReviewProposal } from "./closure-classes";

export function ReviewOperationCard({
  proposal,
  model,
  controller,
  draftId,
  isNewDocument,
  active,
  onFocus,
}: {
  proposal: ReviewProposal;
  model: InlineReviewModel;
  controller: DraftReviewController;
  draftId: string;
  isNewDocument: boolean;
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
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption font-medium text-muted-foreground">
          <ProposalVerb proposal={proposal} isNewDocument={isNewDocument} />
          {proposal.includesWriterEdits ? (
            <Badge variant="neutral">
              <Trans>Includes your edits</Trans>
            </Badge>
          ) : null}
        </span>
        <CardVerbs
          proposal={proposal}
          model={model}
          controller={controller}
          draftId={draftId}
          isNewDocument={isNewDocument}
        />
      </div>
      <ProposalChange proposal={proposal} isNewDocument={isNewDocument} />
      <ProposalAttribution proposal={proposal} />
    </div>
  );
}

/**
 * The proposal's Apply/Create + Discard cluster. Reveals on card hover/focus
 * (matching the doc row's hover-Review verb), but stays visible while this card
 * is in-flight so its state can't hide. Verbs disable while ANY review
 * disposition is in flight (`controller.isDisposing`) so the writer can't stack
 * overlapping accepts/discards. One Apply (or Create for a new document) and one
 * Discard act on the whole closure class — no second-step confirm exists.
 */
function CardVerbs({
  proposal,
  model,
  controller,
  draftId,
  isNewDocument,
}: {
  proposal: ReviewProposal;
  model: InlineReviewModel;
  controller: DraftReviewController;
  draftId: string;
  isNewDocument: boolean;
}) {
  // The verbs run against the class's representative operation; its accept /
  // reject closure spans every operation in the class, so one Apply applies the
  // class and one Discard retires it.
  const operationId = proposal.primaryOperation.operationId;
  // This card is the one running a disposition — drives the visible pending
  // treatment (stays revealed); the disable itself is global (`isDisposing`).
  const activeOnThisCard =
    controller.acceptingOperationId === operationId ||
    controller.pendingInlineDiscardIds(draftId).has(operationId);
  const disabled = controller.isDisposing;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2",
        activeOnThisCard
          ? "opacity-100"
          : "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
      )}
    >
      <VerbButton
        tone="primary"
        disabled={disabled}
        onClick={() => controller.acceptOperation(operationId, model)}
      >
        {/* `Create` (not `Apply`) is the one place the verb diverges: applying
            a document that does not yet exist is honestly a creation. */}
        {isNewDocument ? <Trans>Create</Trans> : <Trans>Apply</Trans>}
      </VerbButton>
      <VerbButton
        tone="muted"
        disabled={disabled}
        onClick={() => void controller.discardOperation(operationId)}
      >
        <Trans>Discard</Trans>
      </VerbButton>
    </div>
  );
}

const VERB_TONE = {
  primary: "text-primary",
  muted: "text-muted-foreground hover:text-foreground",
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

/**
 * Quiet verb for the class. A new document reads `New document`; a merge
 * artifact reads the system-voice `Merged` with a `GitMerge` marker + tooltip
 * (spec §6.2) — distinct from the AI-authored Added / Removed / Rewrote.
 */
function ProposalVerb({
  proposal,
  isNewDocument,
}: {
  proposal: ReviewProposal;
  isNewDocument: boolean;
}) {
  if (isNewDocument) {
    return <Trans>New document</Trans>;
  }
  if (proposal.merged) {
    return (
      <span className="inline-flex items-center gap-1">
        <Trans>Merged</Trans>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t`Why this is marked merged`}
              // The marker only explains; a click must not focus/scroll the card.
              onClick={(event) => event.stopPropagation()}
              className="focus-ring inline-grid place-items-center rounded-sm"
            >
              <GitMerge className="size-3 text-muted-foreground" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-56">
            <Trans>
              Your edits and the AI's overlapped here, so both were combined into one. Read it
              closely before applying.
            </Trans>
          </TooltipContent>
        </Tooltip>
      </span>
    );
  }
  switch (proposal.classification) {
    case "addition":
      return <Trans>Added</Trans>;
    case "removal":
      return <Trans>Removed</Trans>;
    default:
      return <Trans>Rewrote</Trans>;
  }
}

/**
 * Attribution: when a closure class combines more than one AI turn (it may span
 * threads, spec §5.3), a quiet count says so. A single-turn class — the common
 * case — shows nothing; the card is the write.
 */
function ProposalAttribution({ proposal }: { proposal: ReviewProposal }) {
  if (proposal.contributingTurnIds.length <= 1) return null;
  return (
    <p className="text-caption text-muted-foreground/80">
      <Trans>Combines {proposal.contributingTurnIds.length} AI turns</Trans>
    </p>
  );
}

/**
 * The card body: the intended change, styled per class, carrying the editor's
 * inline-review tint tokens so a card reads like the mark it points at. A new
 * document is all additions (jade); a merge artifact renders in the neutral
 * dashed merged tone; otherwise additions/removals/rewrites use their hued
 * tints. Empty change → verb-only card.
 */
function ProposalChange({
  proposal,
  isNewDocument,
}: {
  proposal: ReviewProposal;
  isNewDocument: boolean;
}) {
  const { change, classification, merged } = proposal;
  if (isNewDocument) {
    return change.added ? <TintedChangeText tone="added" text={change.added} clamp={3} /> : null;
  }
  if (merged) {
    // A merge artifact is one combined region — render it as a single
    // full-contrast merged run (no strike, no hued split).
    const text = change.added ?? change.removed;
    return text ? <TintedChangeText tone="merged" text={text} clamp={3} /> : null;
  }
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
 * (`--color-review-{added,removed,merged}-*`) so the card reads the same as the
 * manuscript; `box-decoration-clone` keeps the tint hugging wrapped lines like
 * the editor mark does. The merged tone is neutral + dashed underline, NOT a
 * fourth hued authorship tint (spec §6.2).
 */
export function TintedChangeText({
  tone,
  text,
  clamp,
  size = "caption",
}: {
  tone: "added" | "removed" | "merged";
  text: string;
  clamp?: 2 | 3;
  size?: "caption" | "prose";
}) {
  return (
    <p
      className={cn(
        "whitespace-pre-wrap break-words",
        // `prose-tokens` (not a bare size class): manuscript excerpts ride the
        // manuscript/editor reading scale. Rendered in a portaled dialog, so
        // the chat tier does not apply — intentional (see text-tier-chat).
        size === "prose" ? "prose-tokens" : "text-caption leading-snug",
        clamp === 2 ? "line-clamp-2" : clamp === 3 ? "line-clamp-3" : null,
      )}
    >
      <span className={cn("rounded-[0.125rem] box-decoration-clone px-0.5", TONE_CLASS[tone])}>
        {text}
      </span>
    </p>
  );
}

const TONE_CLASS = {
  added: "bg-[color:var(--color-review-added-tint)] text-foreground",
  removed:
    "bg-[color:var(--color-review-removed-tint)] text-[color:var(--color-review-removed-foreground)] line-through",
  merged:
    "bg-[color:var(--color-review-merged-tint)] border-b border-dashed border-[color:var(--color-review-merged-border)] text-foreground",
} as const;
