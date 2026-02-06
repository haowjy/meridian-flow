import { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { HeaderGradientFade } from "./HeaderGradientFade";

interface MultiRowHeaderProps {
  /** Header rows as children */
  children: ReactNode;
  /** Show gradient fade below header (default: true) */
  showGradient?: boolean;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Multi-row sticky header container with gradient at the bottom.
 *
 * Used for headers that need multiple rows (e.g., DocumentTreePanel):
 * - Row 1: Title + toggle
 * - Row 2: Search + actions
 * - Gradient at bottom
 *
 * Extracts the sticky header + gradient pattern from DocumentTreePanel
 * to allow reuse across multi-row header scenarios.
 */
export function MultiRowHeader({
  children,
  showGradient = true,
  className,
}: MultiRowHeaderProps) {
  return (
    <div className={cn("bg-background sticky top-0 z-20", className)}>
      {children}
      {showGradient && <HeaderGradientFade />}
    </div>
  );
}
