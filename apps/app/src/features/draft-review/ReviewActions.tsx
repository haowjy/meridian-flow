/**
 * ReviewActions — the one Discard · Apply pair for pending changes. Apply is the filled
 * jade button; Discard is quiet ink, never red and never a trash icon (red and the trash
 * belong to Delete). Each scope has one name everywhere (`reviewActionLabel`).
 *
 * A change's or a document's ✓ in a list row is jade ink, not a fill: the group's own Apply
 * is the one filled button, and a column of filled squares would drown it.
 *
 * `density` picks the form: the scope's name, the bare verb, or ×/✓. Leave it unset where
 * a container measures its own fit and sets `data-density` on `[data-review-actions]`
 * itself (the identity row's ladder); React then never resets that attribute.
 */
import { t } from "@lingui/core/macro";
import { Check, Loader2, X } from "lucide-react";
import { type MouseEventHandler, type ReactNode, useRef, useState } from "react";
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

export type ReviewActionsProps = {
  scope: ReviewScope;
  density?: ReviewDensity;
  onDiscard: MouseEventHandler<HTMLButtonElement>;
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
  density,
  onDiscard,
  onApply,
  disabled = false,
  applyDisabled = false,
  applying = false,
  touch = false,
  className,
}: ReviewActionsProps) {
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
        short={reviewActionLabel("discard", "change")}
        icon={<X aria-hidden />}
        variant="quiet"
        touch={touch}
        disabled={disabled}
        onClick={onDiscard}
      />
      {onApply ? (
        <ReviewActionButton
          density={density}
          name={reviewActionLabel("apply", scope)}
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
