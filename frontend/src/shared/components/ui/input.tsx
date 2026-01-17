import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const inputVariants = cva(
  // Base styles
  "file:text-foreground placeholder:text-muted-foreground bg-card border-input w-full min-w-0 rounded-sm border px-3 py-1 text-base transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-[--opacity-disabled] md:text-sm font-sans " +
  // Focus ring
  "focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring-outer)] focus-visible:outline-offset-0 focus-visible:border-transparent focus-visible:shadow-[0_0_0_2px_var(--focus-ring-inner)] " +
  // Error state
  "aria-invalid:outline-[3px] aria-invalid:outline-error aria-invalid:border-error",
  {
    variants: {
      size: {
        default: "h-[var(--component-height-md)]", // 36px (h-9)
        sm: "h-[var(--component-height-sm)]",      // 32px (h-8)
        lg: "h-[var(--component-height-lg)]",      // 40px (h-10) - for auth forms
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

function Input({
  className,
  type,
  size,
  ...props
}: React.ComponentProps<"input"> & VariantProps<typeof inputVariants>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(inputVariants({ size, className }))}
      style={{ boxShadow: "var(--shadow-1)" }}
      {...props}
    />
  )
}

export { Input, inputVariants }
