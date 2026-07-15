/**
 * Input — text input primitive (shadcn-derived; focus treatment is
 * project-owned). Fields are always `:focus-visible` in browsers, so a ring
 * would flare on every click — instead focus is a calm border shift to the
 * soft jade `border-focus` hairline. No halo, no shadow. Keyboard-only focus
 * rings belong to click targets (`focus-ring`), not editable fields.
 */
import type * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base transition-colors outline-none selection:bg-primary/25 selection:text-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
        "focus-visible:border-border-focus",
        "aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
