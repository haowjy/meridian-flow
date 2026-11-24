import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "focus-ring inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[color,background-color,transform] active:scale-[0.98] disabled:cursor-not-allowed disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "interactive bg-primary text-primary-foreground focus-ring-on-fill disabled:bg-ink-fill-strong disabled:text-muted-foreground",
        destructive:
          "interactive bg-destructive text-primary-foreground focus-ring-on-fill disabled:bg-ink-fill-strong disabled:text-muted-foreground",
        outline: "interactive border border-border bg-card shadow-raise",
        secondary: "interactive bg-ink-fill text-foreground",
        ghost: "interactive",
        quiet: "interactive text-muted-foreground hover:text-foreground popup-open:text-foreground",
      },
      size: {
        default: "h-8 px-4 has-[>svg]:px-3 coarse:min-h-11",
        xs: "h-(--control-dense) gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3 coarse:min-h-11",
        meta: "gap-1 rounded-md px-2 py-1 text-xs [&_svg:not([class*='size-'])]:size-3 coarse:min-h-11",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5 coarse:min-h-11",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4 coarse:min-h-11",
        "icon-xs":
          "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3.5 coarse:not-data-[touch=dense]:size-11",
        "icon-sm": "size-8 coarse:not-data-[touch=dense]:size-11",
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
