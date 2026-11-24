import { t } from "@lingui/core/macro";
import { cn } from "@/lib/utils";
import { subagentMarkName } from "./display";
import type { SubagentRunStatus } from "./run-model";

export function SubagentMark({
  agentName,
  status,
  className,
  decorative = false,
}: {
  agentName?: string | null;
  status: SubagentRunStatus;
  className?: string;
  decorative?: boolean;
}) {
  const name = subagentMarkName(agentName);
  const initial = name.charAt(0).toLocaleUpperCase();
  const markClassName = cn(
    "relative grid size-6 shrink-0 place-items-center rounded-full border-[1.5px] bg-background text-xs font-medium text-foreground",
    status === "running" &&
      "border-border after:absolute after:inset-[-1.5px] after:rounded-full after:border-[1.5px] after:border-transparent after:border-t-primary motion-safe:after:animate-spin",
    status === "done" && "border-primary",
    (status === "failed" || status === "cancelled") && "border-destructive",
    status === "unknown" && "border-border",
    className,
    "leading-none [text-box:trim-both_cap_alphabetic]",
  );
  if (decorative) {
    return (
      <span aria-hidden className={markClassName}>
        {initial}
      </span>
    );
  }
  const label =
    status === "running"
      ? t`Running`
      : status === "done"
        ? t`Finished`
        : status === "failed"
          ? t`Failed`
          : status === "cancelled"
            ? t`Stopped`
            : t`Status unknown`;
  return (
    <span role="img" aria-label={label} className={markClassName}>
      {initial}
    </span>
  );
}
