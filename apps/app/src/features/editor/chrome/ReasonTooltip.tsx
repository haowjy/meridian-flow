import type { ComponentProps, ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type ReasonTooltipProps = {
  name?: string;
  reason?: string | null;
  side?: ComponentProps<typeof TooltipContent>["side"];
  children: ReactNode;
};

export function ReasonTooltip({ name, reason, side = "right", children }: ReasonTooltipProps) {
  if (!name && !reason) return <>{children}</>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="max-w-56">
        <ReasonLines name={name} reason={reason} />
      </TooltipContent>
    </Tooltip>
  );
}

export function ReasonLines({ name, reason }: Pick<ReasonTooltipProps, "name" | "reason">) {
  return (
    <>
      {name ? <span className="block">{name}</span> : null}
      {reason ? <span className={cn("block", name && "text-background/70")}>{reason}</span> : null}
    </>
  );
}
