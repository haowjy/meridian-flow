import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

type PaneWrapperProps = {
  children: ReactNode
  className?: string
  /** When true, pane is hidden on phone (secondary content uses drawer/sheet). */
  hideOnPhone?: boolean
}

function PaneWrapper({ children, className, hideOnPhone = false }: PaneWrapperProps) {
  return (
    <section
      data-slot="layout-pane"
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden bg-background",
        hideOnPhone && "hidden tablet:flex",
        className,
      )}
    >
      {children}
    </section>
  )
}

export { PaneWrapper, type PaneWrapperProps }
