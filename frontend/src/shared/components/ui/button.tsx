import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-all cursor-pointer disabled:cursor-not-allowed disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none font-sans has-[>svg]:gap-1.5",
  {
    variants: {
      variant: {
        // Primary: Dark jade fill (#2F7F72) with white text
        default:
          "bg-primary text-primary-foreground hover:opacity-90 " +
          "focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring-outer)] focus-visible:outline-offset-2 " +
          "focus-visible:shadow-[0_0_0_2px_var(--focus-ring-inner)] " +
          "disabled:opacity-[--opacity-disabled]",

        // Accent: Gold outline on jade-black (dark mode pattern can work in light too)
        accent:
          "border-2 border-accent text-accent hover:bg-accent/[--opacity-hover] " +
          "focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring-outer)] focus-visible:outline-offset-2 " +
          "focus-visible:shadow-[0_0_0_2px_var(--focus-ring-inner)] " +
          "disabled:opacity-[--opacity-disabled]",

        // Destructive/Warning: Amber
        destructive:
          "bg-error text-error-foreground hover:opacity-90 " +
          "focus-visible:outline-[3px] focus-visible:outline-error focus-visible:outline-offset-2 " +
          "disabled:opacity-[--opacity-disabled]",

        // Secondary: Dark jade outline
        secondary:
          "border-2 border-primary text-primary hover:bg-[var(--hover)] " +
          "focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring-outer)] focus-visible:outline-offset-2 " +
          "focus-visible:shadow-[0_0_0_2px_var(--focus-ring-inner)] " +
          "disabled:opacity-[--opacity-disabled]",

        // Outline: Border with hover wash
        outline:
          "border border-border bg-background hover:bg-[var(--hover)] " +
          "focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring-outer)] focus-visible:outline-offset-2 " +
          "focus-visible:shadow-[0_0_0_2px_var(--focus-ring-inner)] " +
          "disabled:opacity-[--opacity-disabled]",

        // Ghost: Minimal with hover
        ghost:
          "hover:bg-[var(--hover)] hover:text-foreground " +
          "focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring-outer)] focus-visible:outline-offset-2 " +
          "focus-visible:shadow-[0_0_0_2px_var(--focus-ring-inner)] " +
          "disabled:opacity-[--opacity-disabled]",

        // Link: Jade text with gold hover
        link:
          "text-primary underline-offset-4 hover:underline hover:text-accent " +
          "focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring-outer)] focus-visible:outline-offset-2 " +
          "focus-visible:shadow-[0_0_0_2px_var(--focus-ring-inner)] " +
          "disabled:opacity-[--opacity-disabled]",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:pl-3 has-[>svg]:pr-4 rounded",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:pl-2 has-[>svg]:pr-3 rounded-sm",
        lg: "h-10 px-6 has-[>svg]:pl-4 has-[>svg]:pr-6 rounded",
        icon: "size-9 rounded",
        "icon-sm": "size-8 rounded-sm",
        "icon-lg": "size-10 rounded",
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
