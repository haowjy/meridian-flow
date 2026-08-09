/** Compact current-value trigger shared by composer controls with toolbar-owned panels. */
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ComposerToolbarTriggerBinding } from "./types";

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
    <Button
      ref={binding.ref}
      {...binding.buttonProps}
      type="button"
      variant="outline"
      size="sm"
      aria-label={ariaLabel}
      className={cn(
        "min-h-8 max-w-[11rem] min-w-0 shrink font-medium [@media(pointer:coarse)]:min-h-11",
        className,
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
    </Button>
  );
}
