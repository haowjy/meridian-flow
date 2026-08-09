/** Current-value chrome for interactive composer controls and readonly status. */
import { ChevronDown } from "lucide-react";
import { type ComponentProps, forwardRef, type ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ComposerToolbarTriggerBinding } from "./types";

const currentValueChrome = cn(
  buttonVariants({ variant: "outline", size: null }),
  "h-8 min-h-8 max-w-[11rem] min-w-0 shrink gap-1.5 px-2.5 font-medium [@media(pointer:coarse)]:min-h-11",
);

const CurrentValueChrome = forwardRef<
  HTMLButtonElement,
  Omit<ComponentProps<"button">, "value"> & { value: ReactNode; chevron: boolean }
>(function CurrentValueChrome({ value, chevron, className, ...props }, ref) {
  return (
    <button ref={ref} type="button" className={cn(currentValueChrome, className)} {...props}>
      <span className="min-w-0 truncate">{value}</span>
      {chevron ? (
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      ) : null}
    </button>
  );
});

export type ComposerCurrentValueTriggerProps = {
  ariaLabel: string;
  children: ReactNode;
  binding: ComposerToolbarTriggerBinding;
  className?: string;
};

export function ComposerCurrentValueTrigger({
  ariaLabel,
  children,
  binding,
  className,
}: ComposerCurrentValueTriggerProps) {
  return (
    <CurrentValueChrome
      ref={binding.ref}
      {...binding.buttonProps}
      aria-label={ariaLabel}
      value={children}
      chevron
      className={className}
    />
  );
}

export const ComposerCurrentValueStatus = forwardRef<
  HTMLButtonElement,
  { ariaLabel: string; children: ReactNode; tooltip: string }
>(function ComposerCurrentValueStatus({ ariaLabel, children, tooltip }, ref) {
  return (
    <CurrentValueChrome
      ref={ref}
      aria-disabled="true"
      aria-label={ariaLabel}
      title={tooltip}
      value={children}
      chevron={false}
      className="cursor-default text-muted-foreground opacity-60 shadow-none hover:border-border hover:bg-background hover:text-muted-foreground active:scale-100"
    />
  );
});
