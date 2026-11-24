import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

const chipVariants = cva(
  "inline-flex shrink-0 items-center whitespace-nowrap font-medium font-sans text-xs",
  {
    variants: {
      kind: {
        state: "h-5.5 gap-1.5 rounded-md border px-1.5 transition-colors",
        count: "min-w-5 justify-center rounded-full px-1.5 tabular-nums",
        label:
          "min-w-0 max-w-full shrink rounded-full border border-border-subtle bg-ink-fill px-2 py-px text-muted-foreground",
        badge:
          "h-4 min-w-4 justify-center rounded-full bg-primary px-1 text-primary-foreground tabular-nums leading-none",
      },
      tone: {
        neutral: "border-border-subtle text-muted-foreground",
        jade: "border-primary/40 bg-primary/12 text-jade-text",
        warning: "border-warning/40 bg-warning-tint text-warning-ink",
        destructive: "border-destructive/40 bg-destructive/12 text-destructive",
      },
      dashed: { true: "border-dashed border-border", false: "" },
    },
    compoundVariants: [{ kind: "count", tone: "neutral", className: "bg-ink-fill" }],
    defaultVariants: { kind: "state", tone: "neutral", dashed: false },
  },
);

export type ChipProps = React.ComponentProps<"span"> &
  VariantProps<typeof chipVariants> & { asChild?: boolean };

export function Chip({ className, kind, tone, dashed, asChild = false, ...props }: ChipProps) {
  const Comp = asChild ? Slot.Root : "span";
  return (
    <Comp
      data-slot="chip"
      className={cn(
        chipVariants({ kind, tone: kind === "label" || kind === "badge" ? null : tone, dashed }),
        className,
      )}
      {...props}
    />
  );
}
