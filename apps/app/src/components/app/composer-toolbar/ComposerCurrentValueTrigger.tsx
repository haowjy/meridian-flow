/** Compact current-value trigger shared by composer controls with toolbar-owned panels. */
import { ChevronDown } from "lucide-react";
import { forwardRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ComposerCurrentValueTriggerProps = {
  ariaLabel: string;
  children: ReactNode;
  disabled?: boolean;
  readOnly?: boolean;
  active?: boolean;
  className?: string;
  onActivate?: () => void;
};

export const ComposerCurrentValueTrigger = forwardRef<
  HTMLButtonElement,
  ComposerCurrentValueTriggerProps
>(function ComposerCurrentValueTrigger(
  {
    ariaLabel,
    children,
    disabled = false,
    readOnly = false,
    active = false,
    className,
    onActivate,
  },
  ref,
) {
  const inert = disabled || readOnly;
  return (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      aria-disabled={readOnly || undefined}
      aria-expanded={inert ? undefined : active}
      aria-label={ariaLabel}
      onClick={inert ? undefined : onActivate}
      className={cn(
        "max-w-[11rem] min-w-0 shrink font-medium",
        readOnly &&
          "cursor-default border-transparent bg-transparent text-muted-foreground opacity-60 shadow-none hover:border-transparent hover:bg-transparent",
        className,
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      {!inert ? (
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      ) : null}
    </Button>
  );
});
