import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const labelVariants = cva(
  "flex items-center gap-2 font-medium font-sans group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-[--opacity-disabled] peer-disabled:cursor-not-allowed peer-disabled:opacity-[--opacity-disabled]",
  {
    variants: {
      variant: {
        default: "text-sm leading-none",
        editorial:
          "text-xs uppercase tracking-wide text-muted-foreground leading-none",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Label({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root> &
  VariantProps<typeof labelVariants>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(labelVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Label };
