/** A compact agent identity that carries its run state without extra copy. */

import { t } from "@lingui/core/macro";
import { cn } from "@/lib/utils";
import { subagentMarkName } from "./display";

export function SubagentMark({
  agentName,
  status,
  className,
  decorative = false,
}: {
  agentName?: string | null;
  status: "running" | "done" | "stopped" | "unknown";
  className?: string;
  /** Hide from assistive tech where adjacent text already states the outcome. */
  decorative?: boolean;
}) {
  const name = subagentMarkName(agentName);
  const initial = name.charAt(0).toLocaleUpperCase();
  // The ring is the status: a spinning arc while running, then solid green
  // (finished) or red (stopped). No corner badge, so the mark stays centered.
  const markClassName = cn(
    "relative grid size-6 shrink-0 place-items-center rounded-full border-[1.5px] bg-background text-[11px] font-medium text-foreground",
    status === "running" &&
      "border-border after:absolute after:inset-[-1.5px] after:rounded-full after:border-[1.5px] after:border-transparent after:border-t-primary motion-safe:after:animate-spin",
    status === "done" && "border-primary",
    status === "stopped" && "border-destructive",
    status === "unknown" && "border-border",
    className,
  );
  if (decorative) {
    return (
      <span aria-hidden className={markClassName}>
        {initial}
      </span>
    );
  }
  // The name is always printed beside the mark; the label adds only status.
  const label =
    status === "running"
      ? t`Running`
      : status === "done"
        ? t`Finished`
        : status === "stopped"
          ? t`Stopped`
          : t`Status unknown`;
  return (
    <span role="img" aria-label={label} className={markClassName}>
      {initial}
    </span>
  );
}
