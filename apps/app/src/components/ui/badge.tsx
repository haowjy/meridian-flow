/**
 * Badge — the canonical pill primitive. Most pills should use this directly;
 * domain-specific wrappers can sit on top when their copy is fixed by product
 * semantics.
 *
 * The asymmetric pill geometry now lives here once, instead of being duplicated
 * at every call site. Variants:
 *   - `neutral` (default) — bordered state chip on the subtle surface.
 *   - `status` — shape only; the caller supplies the tone (`bg-*`/`text-*`) for
 *     dynamic status colors (streaming/done/live).
 *   - `count` — compact numeric counter (tabular-nums) on the muted chip fill.
 */
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex shrink-0 items-center rounded-full text-meta", {
  variants: {
    variant: {
      neutral:
        "gap-1.5 border border-border-subtle bg-muted px-[7px] py-[3px] pr-[9px] font-semibold tracking-wide text-ink-subtle",
      status: "gap-1.5 px-[7px] py-[3px] pr-[9px] font-semibold tracking-wide",
      count: "bg-chip-muted-bg px-1.5 font-medium tabular-nums text-ink-subtle",
    },
  },
  defaultVariants: {
    variant: "neutral",
  },
});

export type BadgeProps = React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { badgeVariants };
