/**
 * ReviewActions — the one Discard · Apply pair for pending changes. Apply is the filled
 * jade button; Discard is quiet ink, never red and never a trash icon (red and the trash
 * belong to Delete). Each scope has one name everywhere (`reviewActionNames`).
 *
 * A change's or a document's ✓ in a list row is jade ink, not a fill: the group's own Apply
 * is the one filled button, and a column of filled squares would drown it.
 *
 * Discard never asks: every Discard's notice has its Undo.
 *
 * Each button has a word on screen and a name: the name ("Discard draft", or the caller's
 * `labels` where the row names more) is the accessible name and the tooltip. A change's and a
 * draft's word is the bare verb, since what they act on is named beside them (the change, the
 * Draft chip, the row); `named` says nothing beside the pair names it, and the word is then the
 * name. `density` picks the form: the word or ×/✓. Leave `density` unset where
 * a container measures its own fit and sets `data-density` on `[data-review-actions]`
 * itself (the identity row's ladder); React then never resets that attribute.
 */
import { t } from "@lingui/core/macro";
import { Check, Loader2, X } from "lucide-react";
import { type MouseEventHandler, type ReactNode, useRef, useState } from "react";
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
  /** Nothing beside the pair names its scope: the words on screen are the full names. */
  named?: boolean;
  density?: ReviewDensity;
  /** Absent withdraws Discard: a change no Discard command takes, such as a folder alone. */
  onDiscard?: () => void;
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
  named = false,
  density,
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
    return { word: named ? name : scoped.word, name };
  };
  return (
    <span
      data-review-actions
      data-density={density}
      className={cn(
        "group/review flex shrink-0 items-center whitespace-nowrap",
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
            onDiscard();
          }}
        />
      ) : null}
      {onApply ? (
        <ReviewActionButton
          density={density}
          {...names("apply")}
          icon={applying ? <Loader2 aria-hidden className="animate-spin" /> : <Check aria-hidden />}
          busy={applying}
          variant={scope !== "all" && density === "icon" ? "row" : "default"}
          touch={touch}
          disabled={disabled || applyDisabled}
          onClick={onApply}
        />
      ) : null}
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
  word,
  name,
  icon,
  busy = false,
  variant,
  touch,
  disabled,
  onClick,
}: {
  density: ReviewDensity | undefined;
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
  const fullRef = useRef<HTMLSpanElement>(null);
  const [tooltip, setTooltip] = useState(false);
  const renders = (form: ReviewDensity) => density === undefined || density === form;
  return (
    <Tooltip
      open={tooltip}
      onOpenChange={(open) =>
        setTooltip(open && (name !== word || fullRef.current?.offsetParent == null))
      }
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
              {word}
            </span>
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}
