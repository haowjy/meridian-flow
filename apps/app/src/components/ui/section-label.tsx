/**
 * SectionLabel — the canonical uppercase eyebrow/section label.
 *
 * One primitive so every small uppercase label ("Chats", "Context", column
 * headers, inline group headers, live-status eyebrows) renders at a consistent
 * size/weight/tracking/tone instead of each call site re-picking
 * `text-meta uppercase tracking-*` by hand (the source of the tracking/weight/
 * tone drift the design review flagged).
 *
 * Variants map to the three visual ranks the codebase actually uses, each
 * pinned to one step of the uppercase-tracking scale:
 *   - `section` (default) — architectural section / column header. Widest
 *     tracking, calm weight, muted tone. The left-sidebar "Chats" label is the
 *     reference.
 *   - `group` — inline group / sub-header (work-group names, dropdown
 *     sub-labels). Medium tracking, semibold, subtle ink.
 *   - `status` — live-status eyebrow. Primary tone, semibold.
 *
 * Weight/tracking/tone are owned by the variant; pass `className` only for
 * layout (padding, truncation), not to re-skin the type.
 */
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const sectionLabelVariants = cva("text-meta uppercase", {
  variants: {
    variant: {
      section: "font-normal tracking-section-label text-muted-foreground",
      group: "font-semibold tracking-label text-ink-subtle",
      status: "font-semibold tracking-status text-primary",
    },
  },
  defaultVariants: {
    variant: "section",
  },
});

export type SectionLabelProps = React.ComponentProps<"span"> &
  VariantProps<typeof sectionLabelVariants>;

export function SectionLabel({ className, variant, ...props }: SectionLabelProps) {
  return (
    <span
      data-slot="section-label"
      className={cn(sectionLabelVariants({ variant }), className)}
      {...props}
    />
  );
}

export { sectionLabelVariants };
