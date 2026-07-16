/**
 * Textarea — multiline text input primitive (shadcn-derived; focus treatment
 * is project-owned). Same calm-field focus as `Input`: a border shift to
 * `border-focus`, no ring — see `input.tsx` for why fields never get halos.
 */
import type * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base transition-colors outline-none selection:bg-primary/25 selection:text-foreground placeholder:text-muted-foreground focus-visible:border-border-focus disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
