/** A compact agent identity that carries its run state without extra copy. */

import { t } from "@lingui/core/macro";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

export function SubagentMark({
  name,
  status,
  className,
}: {
  name: string;
  status: "running" | "done" | "stopped";
  className?: string;
}) {
  const initial = name.trim().charAt(0).toLocaleUpperCase() || "?";
  return (
    <span
      role="img"
      className={cn(
        "relative grid size-6 shrink-0 place-items-center rounded-full border border-border bg-background text-[11px] font-medium text-foreground",
        status === "running" && "border-primary/60",
        status === "running" &&
          "after:absolute after:inset-[-2px] after:rounded-full after:border after:border-transparent after:border-t-primary motion-safe:after:animate-spin",
        className,
      )}
      aria-label={t`${name} ${status === "running" ? t`running` : status === "done" ? t`finished` : t`stopped`}`}
    >
      {initial}
      {status !== "running" ? (
        <span
          className={cn(
            "absolute -right-1.5 -bottom-1.5 grid size-3 place-items-center rounded-full border border-background",
            status === "done"
              ? "bg-primary text-primary-foreground"
              : "bg-destructive text-destructive-foreground",
          )}
        >
          {status === "done" ? (
            <Check className="size-2" aria-hidden />
          ) : (
            <X className="size-2" aria-hidden />
          )}
        </span>
      ) : null}
    </span>
  );
}
