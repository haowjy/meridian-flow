/** A compact agent identity that carries its run state without extra copy. */

import { t } from "@lingui/core/macro";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { subagentMarkName } from "./subagent-display";

export function SubagentMark({
  agentName,
  status,
  className,
  decorative = false,
}: {
  agentName?: string | null;
  status: "running" | "done" | "stopped";
  className?: string;
  /** Hide from assistive tech where adjacent text already states the outcome. */
  decorative?: boolean;
}) {
  const name = subagentMarkName(agentName);
  const initial = name.charAt(0).toLocaleUpperCase();
  const markClassName = cn(
    "relative grid size-6 shrink-0 place-items-center rounded-full border border-border bg-background text-[11px] font-medium text-foreground",
    status === "running" && "border-primary/60",
    status === "running" &&
      "after:absolute after:inset-[-2px] after:rounded-full after:border after:border-transparent after:border-t-primary motion-safe:after:animate-spin",
    className,
  );
  const glyph = (
    <>
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
    </>
  );
  if (decorative) {
    return (
      <span aria-hidden className={markClassName}>
        {glyph}
      </span>
    );
  }
  // The name is always printed beside the mark; the label adds only status.
  const label = status === "running" ? t`Running` : status === "done" ? t`Finished` : t`Stopped`;
  return (
    <span role="img" aria-label={label} className={markClassName}>
      {glyph}
    </span>
  );
}
