import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const inputVariants = cva(
  // Base styles
  "file:text-foreground placeholder:text-muted-foreground bg-card border-editor-input-border w-full min-w-0 rounded-sm border px-3 py-1 text-base transition-all outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-[--opacity-disabled] md:text-sm font-sans " +
    // Hover state
    "hover:border-primary/30 " +
    // Focus state (green border)
    "focus-visible:border-primary focus-visible:outline-none " +
    // Error state
    "aria-invalid:border-error aria-invalid:hover:border-error aria-invalid:focus-visible:border-error",
  {
    variants: {
      size: {
        default: "h-[var(--component-height-md)]", // 36px (h-9)
        sm: "h-[var(--component-height-sm)]", // 32px (h-8)
        lg: "h-[var(--component-height-lg)]", // 40px (h-10) - for auth forms
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
);

function Input({
  className,
  type,
  size,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> &
  VariantProps<typeof inputVariants>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(inputVariants({ size, className }))}
      style={{ boxShadow: "var(--editor-inset-shadow)" }}
      {...props}
    />
  );
}

export { Input, inputVariants };
