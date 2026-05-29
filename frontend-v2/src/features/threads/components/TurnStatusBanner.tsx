import { WarningCircle, XCircle } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"

type TurnStatusBannerProps = {
  variant: "error" | "warning"
  message: string
  className?: string
}

export function TurnStatusBanner({ variant, message, className }: TurnStatusBannerProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm",
        variant === "error" &&
          "border-destructive/30 bg-destructive/5 text-destructive",
        variant === "warning" &&
          "border-warning/60 bg-warning/10 text-foreground [&>svg]:text-warning",
        className,
      )}
      role={variant === "error" ? "alert" : "status"}
    >
      {variant === "error" ? (
        <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      ) : (
        <WarningCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      )}
      <p>{message}</p>
    </div>
  )
}
