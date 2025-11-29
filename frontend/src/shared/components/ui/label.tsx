import * as React from "react"
import * as LabelPrimitive from "@radix-ui/react-label"

import { cn } from "@/lib/utils"

function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none font-sans group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-[--opacity-disabled] peer-disabled:cursor-not-allowed peer-disabled:opacity-[--opacity-disabled]",
        className
      )}
      {...props}
    />
  )
}

export { Label }
