import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-all cursor-pointer disabled:pointer-events-none disabled:cursor-not-allowed [&_svg]:pointer-events-none shrink-0 [&_svg]:shrink-0 outline-none font-sans relative after:absolute after:-inset-2 after:content-['']",
  {
    variants: {
      variant: {
        // PRIMARY: Dark warm ink fill, light text, pill shape
        // Use for: Main CTAs ("New project", "Sign in", "Send")
        default:
          "bg-foreground text-background rounded-md hover:opacity-90 " +
          "focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring-outer)] focus-visible:outline-offset-2 " +
          "focus-visible:shadow-[0_0_0_2px_var(--focus-ring-inner)] " +
          "disabled:opacity-[--opacity-disabled]",

        // SECONDARY: Subtle border, warm ink text
        // Use for: Secondary actions ("Cancel", "Back")
        secondary:
          "border border-border text-foreground rounded-md hover:bg-[var(--hover)] " +
          "focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring-outer)] focus-visible:outline-offset-2 " +
          "focus-visible:shadow-[0_0_0_2px_var(--focus-ring-inner)] " +
          "disabled:opacity-[--opacity-disabled]",

        // OUTLINE: Same as secondary but with background
        // Use for: Standalone secondary buttons
        outline:
          "border border-border bg-background rounded-md hover:bg-[var(--hover)] " +
          "focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring-outer)] focus-visible:outline-offset-2 " +
          "focus-visible:shadow-[0_0_0_2px_var(--focus-ring-inner)] " +
          "disabled:opacity-[--opacity-disabled]",

        // GHOST: Invisible until hover, text-like
        // Use for: Toolbar controls, dropdown triggers
        ghost:
          "rounded-md hover:bg-[var(--hover)] hover:text-foreground " +
          "focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring-outer)] focus-visible:outline-offset-2 " +
          "focus-visible:shadow-[0_0_0_2px_var(--focus-ring-inner)] " +
          "disabled:opacity-[--opacity-disabled]",

        // DESTRUCTIVE: Red fill for dangerous actions
        destructive:
          "bg-error text-error-foreground rounded-md hover:opacity-90 " +
          "focus-visible:outline-[3px] focus-visible:outline-error focus-visible:outline-offset-2 " +
          "disabled:opacity-[--opacity-disabled]",

        // ACCENT: Background with primary color text
        accent:
          "bg-primary/10 text-primary rounded-md hover:bg-primary/20 " +
          "focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring-outer)] focus-visible:outline-offset-2 " +
          "focus-visible:shadow-[0_0_0_2px_var(--focus-ring-inner)] " +
          "disabled:opacity-[--opacity-disabled]",

        // LINK: Underline on hover
        link:
          "text-primary underline-offset-4 hover:underline " +
          "focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring-outer)] focus-visible:outline-offset-2 " +
          "focus-visible:shadow-[0_0_0_2px_var(--focus-ring-inner)] " +
          "disabled:opacity-[--opacity-disabled]",
      },
      size: {
        // Standard sizes - pill shape with icon scaling
        default: "h-9 px-3 py-2 rounded-md [&_svg]:size-4",
        sm: "h-8 px-2.5 gap-1.5 rounded-md [&_svg]:size-3.5",
        lg: "h-10 px-4 rounded-md [&_svg]:size-5",

        // Compact for inline controls (dropdowns, toolbars)
        xs: "h-7 px-2 gap-1 text-xs rounded-md [&_svg]:size-3",

        // Icon buttons - subtle rounded squares with proportional icons
        "icon-xs": "size-5 rounded [&_svg]:size-2.5",
        "icon-sm": "size-6 rounded [&_svg]:size-3",
        icon: "size-7 rounded [&_svg]:size-3.5",
        "icon-lg": "size-8 rounded [&_svg]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
