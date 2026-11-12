/**
 * ReviewActions — the one Discard · Apply pair for pending changes. Apply is the filled
 * jade button; Discard is quiet ink, never red and never a trash icon (red and the trash
 * belong to Delete). Each scope has one name everywhere (`reviewActionLabel`).
 *
 * A change's or a document's ✓ in a list row is jade ink, not a fill: the group's own Apply
 * is the one filled button, and a column of filled squares would drown it.
 *
 * A Discard with no Undo asks once (`discardAsks`): its question takes the pair's place until
 * the writer keeps the draft or confirms. An undoable Discard never asks.
 *
 * `density` picks the form: the verb or ×/✓. A change's and a draft's actions show the bare
 * verb, since what they act on is named beside them (the change, the Draft chip, the row);
 * the scope's full name ("Discard draft") is the accessible name and the tooltip, and
 * `labels` replaces it where the row names more. Leave `density` unset where
 * a container measures its own fit and sets `data-density` on `[data-review-actions]`
 * itself (the identity row's ladder); React then never resets that attribute.
 */
import { t } from "@lingui/core/macro";
import { Check, Loader2, X } from "lucide-react";
import { type MouseEventHandler, type ReactNode, useRef, useState } from "react";
import { AskOnce } from "@/components/app/AskOnce";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type ReviewScope = "change" | "document" | "all";
export type ReviewDensity = "full" | "icon";

export function reviewActionLabel(action: "apply" | "discard", scope: ReviewScope): string {
  if (action === "apply") {
    return scope === "change" ? t`Apply` : scope === "document" ? t`Apply draft` : t`Apply all`;
  }
  return scope === "change" ? t`Discard` : scope === "document" ? t`Discard draft` : t`Discard all`;
}

/** The visible word: the verb alone, except "Apply all" and "Discard all", whose scope is the word. */
function reviewActionVerb(action: "apply" | "discard", scope: ReviewScope): string {
  if (scope === "all") return reviewActionLabel(action, scope);
  return action === "apply" ? t`Apply` : t`Discard`;
}

/**
 * A Discard's one question, in the place of the controls that asked it: the Discard carries no
 * Undo.
 */
export function DiscardQuestion({
  scope,
  onKeep,
  onConfirm,
  returnFocus,
  touch = false,
  className,
}: {
  scope: ReviewScope;
  onKeep(): void;
  onConfirm(): void;
  /** Where Keep puts the focus when the question took the place of the control that asked. */
  returnFocus?: () => HTMLElement | null | undefined;
  touch?: boolean;
  className?: string;
}) {
  return (
    <AskOnce
      sentence={discardQuestion(scope)}
      keep={t`Keep`}
      confirm={t`Discard`}
      onKeep={onKeep}
      onConfirm={onConfirm}
      returnFocus={returnFocus}
      touch={touch}
      className={className}
    />
  );
}

function discardQuestion(scope: ReviewScope): string {
  return scope === "change"
    ? t`Discard this change? This can't be undone.`
    : scope === "document"
      ? t`Discard this draft? This can't be undone.`
      : t`Discard these drafts? This can't be undone.`;
}

export type ReviewActionsProps = {
  scope: ReviewScope;
  /** Accessible names, where the visible words don't say what the buttons act on. */
  labels?: { apply: string; discard: string };
  density?: ReviewDensity;
  onDiscard: () => void;
  /** The Discard carries no Undo, so it asks first. */
  discardAsks?: boolean;
  /** Absent withdraws Apply; Discard still applies. */
  onApply?: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  applyDisabled?: boolean;
  /** An Apply in flight: a spinner takes the ✓'s place. */
  applying?: boolean;
  /** 44px targets with body-size labels (the phone's change bar and rows). */
  touch?: boolean;
  className?: string;
};

export function ReviewActions({
  scope,
  labels,
  density,
  onDiscard,
  discardAsks = false,
  onApply,
  disabled = false,
  applyDisabled = false,
  applying = false,
  touch = false,
  className,
}: ReviewActionsProps) {
  const [asking, setAsking] = useState(false);
  // Outlives the swap between the buttons and the question, so Keep can find Discard again.
  const place = useRef<HTMLSpanElement>(null);
  if (asking && discardAsks && !disabled)
    return (
      <span ref={place} className="contents">
        <DiscardQuestion
          scope={scope}
          className={className}
          returnFocus={() => place.current?.querySelector("button")}
          onKeep={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            onDiscard();
          }}
        />
      </span>
    );
  return (
    <span ref={place} className="contents">
      <span
        data-review-actions
        data-density={density}
        className={cn(
          "group/review flex shrink-0 items-center whitespace-nowrap",
          touch ? "gap-3" : "gap-1.5",
          className,
        )}
      >
        <ReviewActionButton
          density={density}
          name={reviewActionVerb("discard", scope)}
          label={labels?.discard ?? reviewActionLabel("discard", scope)}
          icon={<X aria-hidden />}
          variant="quiet"
          touch={touch}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            if (discardAsks) setAsking(true);
            else onDiscard();
          }}
        />
        {onApply ? (
          <ReviewActionButton
            density={density}
            name={reviewActionVerb("apply", scope)}
            label={labels?.apply ?? reviewActionLabel("apply", scope)}
            icon={
              applying ? <Loader2 aria-hidden className="animate-spin" /> : <Check aria-hidden />
            }
            busy={applying}
            variant={scope !== "all" && density === "icon" ? "row" : "default"}
            touch={touch}
            disabled={disabled || applyDisabled}
            onClick={onApply}
          />
        ) : null}
      </span>
    </span>
  );
}

/**
 * One action's form. A set `density` renders that form alone; unset, both render and
 * the container's `data-density` shows one. The full name is the accessible name
 * throughout, and the tooltip carries it whenever the words on screen don't say all of it.
 */
function ReviewActionButton({
  density,
  name,
  label,
  icon,
  busy = false,
  variant,
  touch,
  disabled,
  onClick,
}: {
  density: ReviewDensity | undefined;
  name: string;
  /** The accessible name when it says more than `name`. */
  label?: string;
  icon: ReactNode;
  /** Shows the icon in every form. */
  busy?: boolean;
  variant: "quiet" | "default" | "row";
  touch: boolean;
  disabled: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
}) {
  const fullRef = useRef<HTMLSpanElement>(null);
  const [tooltip, setTooltip] = useState(false);
  const renders = (form: ReviewDensity) => density === undefined || density === form;
  const accessibleName = label ?? name;
  return (
    <Tooltip
      open={tooltip}
      onOpenChange={(open) =>
        setTooltip(open && (accessibleName !== name || fullRef.current?.offsetParent == null))
      }
    >
      <TooltipTrigger asChild>
        <Button
          variant={variant === "row" ? "ghost" : variant}
          size="xs"
          aria-label={accessibleName}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            variant === "row" && "text-jade-text",
            "coarse:min-w-11",
            "group-data-[density=icon]/review:w-6 group-data-[density=icon]/review:px-0",
            touch &&
              "h-11 min-w-11 px-4 text-sm group-data-[density=icon]/review:w-11 [&_svg:not([class*='size-'])]:size-5",
          )}
        >
          {busy || renders("icon") ? (
            <span
              className={busy ? "contents" : "hidden group-data-[density=icon]/review:contents"}
            >
              {icon}
            </span>
          ) : null}
          {renders("full") ? (
            <span ref={fullRef} className="group-data-[density=icon]/review:hidden">
              {name}
            </span>
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{accessibleName}</TooltipContent>
    </Tooltip>
  );
}
