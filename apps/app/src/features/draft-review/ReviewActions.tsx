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
 * `density` picks the form: the scope's name, the bare verb, or ×/✓. Leave it unset where
 * a container measures its own fit and sets `data-density` on `[data-review-actions]`
 * itself (the identity row's ladder); React then never resets that attribute.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Check, Loader2, X } from "lucide-react";
import { type MouseEventHandler, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type ReviewScope = "change" | "document" | "all";
export type ReviewDensity = "full" | "short" | "icon";

export function reviewActionLabel(action: "apply" | "discard", scope: ReviewScope): string {
  if (action === "apply") {
    return scope === "change" ? t`Apply` : scope === "document" ? t`Apply draft` : t`Apply all`;
  }
  return scope === "change" ? t`Discard` : scope === "document" ? t`Discard draft` : t`Discard all`;
}

/**
 * A Discard's one question, in the place of the controls that asked it: the Discard carries no
 * Undo. Focus moves to it, so a row that reveals its actions on focus keeps it shown.
 */
export function DiscardQuestion({
  scope,
  onKeep,
  onConfirm,
  touch = false,
  className,
}: {
  scope: ReviewScope;
  onKeep(): void;
  onConfirm(): void;
  touch?: boolean;
  className?: string;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirm.current?.focus();
  }, []);
  const button = cn("text-button", touch ? "min-h-11" : "coarse:min-h-11");
  return (
    <span
      data-discard-question={scope}
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-muted-foreground",
        className,
      )}
    >
      <span className="min-w-0">{discardQuestion(scope)}</span>
      <span className="flex shrink-0 items-center gap-2">
        <button type="button" className={button} onClick={onKeep}>
          <Trans>Keep</Trans>
        </button>
        <button ref={confirm} type="button" className={button} onClick={onConfirm}>
          <Trans>Discard</Trans>
        </button>
      </span>
    </span>
  );
}

function discardQuestion(scope: ReviewScope): string {
  return scope === "change"
    ? t`Discard this change? This can't be undone.`
    : scope === "document"
      ? t`Discard this draft? This can't be undone.`
      : t`Discard these drafts? This can't be undone.`;
}

/** A document's command named with the document, for a list where every row has the pair. */
function documentLabel(action: "apply" | "discard", subject: string): string {
  return action === "apply" ? t`Apply draft of ${subject}` : t`Discard draft of ${subject}`;
}

export type ReviewActionsProps = {
  scope: ReviewScope;
  /** With `scope="document"`: the document's name, added to the accessible names. */
  subject?: string;
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
  subject,
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
  if (asking && discardAsks && !disabled)
    return (
      <DiscardQuestion
        scope={scope}
        className={className}
        onKeep={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          onDiscard();
        }}
      />
    );
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
      <ReviewActionButton
        density={density}
        name={reviewActionLabel("discard", scope)}
        label={subject && scope === "document" ? documentLabel("discard", subject) : undefined}
        short={reviewActionLabel("discard", "change")}
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
          name={reviewActionLabel("apply", scope)}
          label={subject && scope === "document" ? documentLabel("apply", subject) : undefined}
          short={reviewActionLabel("apply", "change")}
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
 * One action's form. A set `density` renders that form alone; unset, all three render and
 * the container's `data-density` shows one. The full name is the accessible name
 * throughout, and the tooltip carries it whenever the full name isn't on screen.
 */
function ReviewActionButton({
  density,
  name,
  label,
  short,
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
  short: string;
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
  // A change's short form is its full name, so it shows the full form instead.
  const shortForm = short === name ? null : short;
  return (
    <Tooltip
      open={tooltip}
      onOpenChange={(open) => setTooltip(open && fullRef.current?.offsetParent == null)}
    >
      <TooltipTrigger asChild>
        <Button
          variant={variant === "row" ? "ghost" : variant}
          size="xs"
          aria-label={label ?? name}
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
          {renders("full") || (renders("short") && !shortForm) ? (
            <span
              ref={fullRef}
              className={cn(
                "group-data-[density=icon]/review:hidden",
                shortForm && "group-data-[density=short]/review:hidden",
              )}
            >
              {name}
            </span>
          ) : null}
          {shortForm && renders("short") ? (
            <span className="hidden group-data-[density=short]/review:inline">{shortForm}</span>
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}
