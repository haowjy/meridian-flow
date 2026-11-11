/**
 * An icon-only door in a pane's band to a landing (Recently opened), right after the sidebar
 * toggle. Active when the landing is the page below (the page rises into it).
 */
import type { LucideIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { tabChipClass } from "./tab-chip";

export function IndexTabChip({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={cn("focus-ring shrink-0", tabChipClass(active))}
        >
          <Icon className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
