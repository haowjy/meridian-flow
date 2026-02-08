/**
 * CollapsibleToolBlock - Shared collapsible container for tool blocks
 *
 * Provides a consistent structure for tool blocks with:
 * - Collapsible header with icon, label, and status badge
 * - Optional action buttons (rendered OUTSIDE the trigger to avoid nested buttons)
 * - Expandable content area
 *
 * This component fixes the nested button issue by separating the trigger zone
 * from action buttons, following SRP (Single Responsibility Principle).
 */

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/shared/components/ui/collapsible";
import {
  threadToolContentPadding,
  threadToolHeaderPadding,
} from "../../styles";

export interface CollapsibleToolBlockProps {
  /** Icon component to display in header */
  icon: LucideIcon;
  /** Main label content (e.g., command + path) */
  label: React.ReactNode;
  /** Status badge component */
  statusBadge: React.ReactNode;
  /** Optional action buttons - rendered OUTSIDE trigger to avoid nested buttons */
  actions?: React.ReactNode;
  /** Controlled expanded state */
  isExpanded: boolean;
  /** Callback when expanded state changes */
  onExpandedChange: (expanded: boolean) => void;
  /** Content to show when expanded */
  children: React.ReactNode;
  /** Whether the tool is preparing/streaming args (shows shimmer animation) */
  isGenerating?: boolean;
  /** Whether the tool is executing on the backend (shows pulse animation) */
  isExecuting?: boolean;
}

export function CollapsibleToolBlock({
  icon: Icon,
  label,
  statusBadge,
  actions,
  isExpanded,
  onExpandedChange,
  children,
  isGenerating,
  isExecuting,
}: CollapsibleToolBlockProps) {
  return (
    <Collapsible open={isExpanded} onOpenChange={onExpandedChange}>
      <div
        className={cn(
          "rounded-lg border",
          "bg-card/50 hover:bg-card/80",
          "transition-colors duration-150",
          "overflow-hidden",
          // Shimmer during PREPARING (args streaming), pulse during EXECUTING (running)
          isGenerating && "animate-generating-border-shimmer",
          isExecuting && !isGenerating && "animate-executing-pulse",
        )}
      >
        {/* Header row - split into trigger zone and action zone */}
        <div className="flex items-center">
          {/* TRIGGER ZONE - handles expand/collapse */}
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2",
                threadToolHeaderPadding,
                "cursor-pointer text-left",
                "hover:bg-muted/50 transition-colors",
                "@container",
              )}
              style={{ containerType: "inline-size" }}
            >
              <Icon className="text-muted-foreground/70 h-3 w-3 shrink-0" />
              <div
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2",
                  isGenerating && "animate-generating-shimmer",
                )}
              >
                {label}
              </div>
              <div className="hidden shrink-0 @[300px]:block">
                {statusBadge}
              </div>
            </button>
          </CollapsibleTrigger>

          {/* ACTION ZONE - styled segment matching trigger hover behavior */}
          {actions && (
            <div
              className={cn(
                "flex shrink-0 items-center self-stretch",
                "relative",
                "before:absolute before:top-1/2 before:left-0 before:-translate-y-1/2",
                "before:bg-muted-foreground/15 before:h-4 before:w-px",
                "px-2",
                "hover:bg-muted/50 transition-colors duration-150",
              )}
            >
              {actions}
            </div>
          )}
        </div>

        {/* Expanded content */}
        <CollapsibleContent>
          <div className={cn("space-y-2 border-t", threadToolContentPadding)}>
            {children}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
