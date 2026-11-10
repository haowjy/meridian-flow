/**
 * Button — shadcn-derived button primitive with `cva` variant/size styles and
 * `asChild` slot support. Customize via `cn()` + tokens at call sites; the
 * focus treatment (`focus-ring`, keyboard-only) is project-owned.
 */
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // focus-ring, not shadcn's 3px halo: buttons only show focus during
  // keyboard navigation (browser :focus-visible heuristic), and when they do
  // it speaks the app's one focus language.
  "focus-ring inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[color,background-color,box-shadow,transform] active:scale-[0.98] disabled:cursor-not-allowed disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Every variant takes its hover, pressed and open states from `interactive`, an
        // ink layer over whatever fill the variant paints.
        default: "interactive bg-primary text-primary-foreground",
        destructive: "interactive bg-destructive text-primary-foreground",
        outline: "interactive border border-border bg-card shadow-raise",
        secondary: "interactive bg-ink-fill text-foreground",
        ghost: "interactive",
        // Quiet chrome affordance: muted at rest. The default tone for dense icon-only
        // buttons (see IconButton).
        quiet: "interactive text-muted-foreground hover:text-foreground popup-open:text-foreground",
        link: "text-jade-text underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-4 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        // Dense inline toolbar action (history/restore/meta actions) — text-meta,
        // no fixed height so it hugs its label. Pair with variant="quiet".
        meta: "gap-1 rounded-md px-2 py-1 text-meta [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-8",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
