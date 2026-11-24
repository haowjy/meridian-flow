/**
 * ReviewActions — the one Discard · Apply pair for pending changes. Apply is the filled
 * jade button; Discard is quiet ink, never red and never a trash icon (red and the trash
 * belong to Delete). Each scope has one name everywhere (`reviewActionNames`).
 *
 * A change's or a document's ✓ in a list row (`row`) is jade ink, not a fill: the group's own Apply
 * is the one filled button, and a column of filled squares would drown it.
 *
 * Discard never asks: every Discard's notice has its Undo.
 *
 * Each button has a word on screen or an icon, and a name: the name ("Discard draft", or the
 * caller's `labels` where the row names more) is the accessible name and the tooltip. A change's
 * and a draft's word is the bare verb, since what they act on is named beside them (the change,
 * the Draft chip, the row); `named` says nothing beside the pair names it, and the word is then
 * the name. `density` picks the form: the word or ×/✓.
 */
import { t } from "@lingui/core/macro";
import { Check, Loader2, X } from "lucide-react";
import { type MouseEventHandler, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type ReviewScope = "change" | "document" | "all";
type ReviewDensity = "full" | "icon";

/** The scope's name, and its word beside a name: the bare verb, except for "all", whose scope is the word. */
function reviewActionNames(
  action: "apply" | "discard",
  scope: ReviewScope,
): { word: string; name: string } {
  if (action === "apply") {
    const name =
      scope === "change" ? t`Apply` : scope === "document" ? t`Apply draft` : t`Apply all`;
    return { word: scope === "all" ? name : t`Apply`, name };
  }
  const name =
    scope === "change" ? t`Discard` : scope === "document" ? t`Discard draft` : t`Discard all`;
  return { word: scope === "all" ? name : t`Discard`, name };
}

type ReviewActionsProps = {
  scope: ReviewScope;
  /** Names, where the scope's name doesn't say all the buttons act on. */
  labels?: { apply: string; discard: string };
  /** Words on screen in place of the bare verbs: `Restore` for a deleted document's Discard. */
  words?: { discard?: string };
  /** Nothing beside the pair names its scope: the words on screen are the full names. */
  named?: boolean;
  density: ReviewDensity;
  /** In a list row: Apply's ✓ is jade ink, not a fill. */
  row?: boolean;
  /** Absent withdraws Discard: a change no Discard command takes, such as a folder alone. */
  onDiscard?: MouseEventHandler<HTMLButtonElement>;
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
  words,
  named = false,
  density,
  row = false,
  onDiscard,
  onApply,
  disabled = false,
  applyDisabled = false,
  applying = false,
  touch = false,
  className,
}: ReviewActionsProps) {
  const names = (action: "apply" | "discard") => {
    const scoped = reviewActionNames(action, scope);
    const name = labels?.[action] ?? scoped.name;
    const word = action === "discard" ? words?.discard : undefined;
    return { word: word ?? (named ? name : scoped.word), name };
  };
  return (
    <span
      data-review-actions
      className={cn(
        "flex shrink-0 items-center whitespace-nowrap",
        touch ? "gap-3" : "gap-1.5",
        className,
      )}
    >
      {onDiscard ? (
        <ReviewActionButton
          density={density}
          {...names("discard")}
          icon={<X aria-hidden />}
          variant="quiet"
          touch={touch}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onDiscard(event);
          }}
        />
      ) : null}
      {onApply ? (
        <ReviewActionButton
          density={density}
          {...names("apply")}
          icon={applying ? <Loader2 aria-hidden className="animate-spin" /> : <Check aria-hidden />}
          busy={applying}
          variant={row ? "row" : "default"}
          touch={touch}
          disabled={disabled || applyDisabled}
          onClick={onApply}
        />
      ) : null}
    </span>
  );
}

/** One action's form; the full name is the accessible name, and the tooltip wherever the form doesn't say all of it. */
function ReviewActionButton({
  density,
  word,
  name,
  icon,
  busy = false,
  variant,
  touch,
  disabled,
  onClick,
}: {
  density: ReviewDensity;
  /** On screen in the full form. */
  word: string;
  /** The accessible name and the tooltip. */
  name: string;
  icon: ReactNode;
  /** Shows the icon in every form. */
  busy?: boolean;
  variant: "quiet" | "default" | "row";
  touch: boolean;
  disabled: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
}) {
  const iconOnly = density === "icon";
  const [tooltip, setTooltip] = useState(false);
  return (
    <Tooltip
      open={tooltip}
      onOpenChange={(open) => setTooltip(open && (iconOnly || name !== word))}
    >
      <TooltipTrigger asChild>
        <Button
          variant={variant === "row" ? "ghost" : variant}
          size="xs"
          aria-label={name}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            variant === "row" && "text-jade-text",
            "coarse:min-w-11",
            iconOnly && "w-6 px-0",
            touch && "h-11 min-w-11 px-4 text-sm [&_svg:not([class*='size-'])]:size-5",
            touch && iconOnly && "w-11",
          )}
        >
          {busy || iconOnly ? icon : null}
          {iconOnly ? null : word}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}
