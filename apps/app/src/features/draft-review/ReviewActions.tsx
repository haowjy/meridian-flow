import { t } from "@lingui/core/macro";
import { Check, Loader2, X } from "lucide-react";
import { type MouseEventHandler, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type ReviewScope = "change" | "document" | "all";
type ReviewDensity = "full" | "icon";

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
  labels?: { apply: string; discard: string };
  words?: { discard?: string };
  named?: boolean;
  density: ReviewDensity;
  row?: boolean;
  onDiscard?: MouseEventHandler<HTMLButtonElement>;
  onApply?: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  applyDisabled?: boolean;
  applying?: boolean;
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
  word: string;
  name: string;
  icon: ReactNode;
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
