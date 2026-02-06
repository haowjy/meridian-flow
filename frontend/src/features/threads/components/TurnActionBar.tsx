import React, { useState, useCallback, useMemo } from "react";
import { Turn } from "@/features/threads/types";
import {
  ChevronLeft,
  ChevronRight,
  Edit2,
  RefreshCw,
  Copy,
  Check,
  Info,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { makeLogger } from "@/core/lib/logger";
import { extractTextContent } from "@/features/threads/utils/turnHelpers";
import { TurnDebugDialog } from "@/core/components/DebugInfoDialog";

const log = makeLogger("TurnActionBar");

interface TurnActionBarProps {
  turn: Turn;
  isLoading?: boolean;
  onNavigate: (turnId: string) => void;
  onEdit?: () => void;
  onRegenerate?: () => void;
  className?: string;
}

/**
 * Action bar for turn navigation and operations.
 *
 * Performance: Memoized to prevent unnecessary re-renders.
 * Event handlers are wrapped in useCallback to maintain referential equality.
 */
export const TurnActionBar = React.memo(function TurnActionBar({
  turn,
  isLoading = false,
  onNavigate,
  onEdit,
  onRegenerate,
  className,
}: TurnActionBarProps) {
  const [copied, setCopied] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const isDevMode = import.meta.env.VITE_DEV_TOOLS === "1";

  // Memoize sibling calculations to avoid recalculating on every render
  const {
    siblingList,
    siblingCount,
    currentIndex,
    currentNumber,
    showNavigation,
  } = useMemo(() => {
    // Server may or may not include the current turn ID in siblingIds.
    // Build a stable list that always contains the current turn first if missing.
    const siblingIdsRaw = turn.siblingIds || [];
    const siblingList = siblingIdsRaw.includes(turn.id)
      ? siblingIdsRaw
      : [turn.id, ...siblingIdsRaw];
    const siblingCount = siblingList.length;
    const currentIndex = siblingList.indexOf(turn.id);
    // If not found (shouldn't happen if data is consistent), default to 0/0 or hide
    const currentNumber = currentIndex !== -1 ? currentIndex + 1 : 1;
    const showNavigation = siblingCount > 1;

    return {
      siblingList,
      siblingCount,
      currentIndex,
      currentNumber,
      showNavigation,
    };
  }, [turn.id, turn.siblingIds]);

  const handleCopy = useCallback(async () => {
    try {
      const content = extractTextContent(turn);
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      log.error("Failed to copy text", err);
    }
  }, [turn]);

  const handlePrev = useCallback(() => {
    if (currentIndex > 0) {
      const prevId = siblingList[currentIndex - 1];
      if (prevId) onNavigate(prevId);
    }
  }, [currentIndex, siblingList, onNavigate]);

  const handleNext = useCallback(() => {
    if (currentIndex < siblingCount - 1) {
      const nextId = siblingList[currentIndex + 1];
      if (nextId) onNavigate(nextId);
    }
  }, [currentIndex, siblingCount, siblingList, onNavigate]);

  return (
    <div
      className={cn(
        "text-muted-foreground flex items-center gap-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100",
        className,
      )}
    >
      <div className="flex items-center gap-1">
        <button
          onClick={handleCopy}
          className="touch-target-inline hover:bg-muted hover:text-foreground rounded p-1 transition-colors"
          aria-label="Copy text"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>

        {onEdit && (
          <button
            onClick={onEdit}
            disabled={isLoading}
            className="touch-target-inline hover:bg-muted hover:text-foreground rounded p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Edit message"
          >
            <Edit2 className="size-3" />
          </button>
        )}

        {onRegenerate && (
          <button
            onClick={onRegenerate}
            disabled={isLoading}
            className="touch-target-inline hover:bg-muted hover:text-foreground rounded p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Regenerate response"
          >
            <RefreshCw className="size-3" />
          </button>
        )}

        {isDevMode && (
          <button
            onClick={() => setShowDebug(true)}
            className="touch-target-inline hover:bg-muted hover:text-foreground rounded p-1 transition-colors"
            aria-label="Debug info"
          >
            <Info className="size-3" />
          </button>
        )}
      </div>

      {showNavigation && (
        <div className="text-muted-foreground/60 flex items-center gap-0">
          <button
            onClick={handlePrev}
            disabled={currentIndex === 0 || isLoading}
            className="touch-target-inline hover:bg-muted hover:text-foreground rounded p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-30 sm:p-1"
            aria-label="Previous version"
          >
            <ChevronLeft className="size-3" />
          </button>
          <span className="text-center text-[10px] font-medium select-none">
            {currentNumber}/{siblingCount}
          </span>
          <button
            onClick={handleNext}
            disabled={currentIndex === siblingCount - 1 || isLoading}
            className="touch-target-inline hover:bg-muted hover:text-foreground rounded p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-30 sm:p-1"
            aria-label="Next version"
          >
            <ChevronRight className="size-3" />
          </button>
        </div>
      )}

      {isDevMode && (
        <TurnDebugDialog
          isOpen={showDebug}
          onClose={() => setShowDebug(false)}
          turn={turn}
        />
      )}
    </div>
  );
});
