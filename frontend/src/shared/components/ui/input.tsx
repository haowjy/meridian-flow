import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground bg-card border-input h-9 w-full min-w-0 rounded-sm border px-3 py-1 text-base transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-[--opacity-disabled] md:text-sm font-sans",
        "focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring-outer)] focus-visible:outline-offset-0 focus-visible:border-transparent focus-visible:shadow-[0_0_0_2px_var(--focus-ring-inner)]",
        "aria-invalid:outline-[3px] aria-invalid:outline-error aria-invalid:border-error",
        className
      )}
      style={{ boxShadow: "var(--shadow-1)" }}
      {...props}
    />
  )
}

export { Input }
