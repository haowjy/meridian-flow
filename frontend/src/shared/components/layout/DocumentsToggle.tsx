import { PanelLeft, PanelRight } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import { useUIStore } from "@/core/stores/useUIStore";
import { cn } from "@/lib/utils";

interface DocumentsToggleProps {
  className?: string;
  /**
   * Controls which icon is shown:
   * - 'right': PanelRight icon (opens docs, used on left panel)
   * - 'left': PanelLeft icon (closes docs, used on right panel)
   */
  direction?: "left" | "right";
}

/**
 * Toggle button for the documents panel (right side).
 *
 * Design Philosophy:
 * - Chat is the anchor (always visible), documents are dismissible context
 * - This button lets users show/hide documents without leaving the conversation
 * - Button appears contextually: left panel when docs hidden, right panel when docs shown
 * - Icon points toward the action result (PanelRight = "opens right", PanelLeft = "closes to left")
 */
export function DocumentsToggle({
  className,
  direction = "right",
}: DocumentsToggleProps) {
  const toggle = useUIStore((s) => s.toggleRightPanel);

  // Label based on direction: right opens docs, left closes docs
  const label = direction === "right" ? "Show documents" : "Hide documents";
  const Icon = direction === "right" ? PanelRight : PanelLeft;

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      className={cn("hidden md:inline-flex", className)}
      aria-label={label}
      title={label}
    >
      <Icon />
    </Button>
  );
}
