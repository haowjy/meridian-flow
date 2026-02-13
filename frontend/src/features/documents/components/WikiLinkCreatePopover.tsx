/**
 * Wiki-Link Create Popover
 *
 * Inline confirmation popover shown when clicking a broken wiki-link pill.
 * Asks the user to confirm document creation, then creates the document
 * (including missing folders) and navigates to it.
 *
 * Positioned absolutely relative to the editor container using click coordinates.
 * Closes on Escape, click-outside, or Cancel.
 */

import { useEffect, useRef } from "react";
import { FileText, FolderPlus, Loader2 } from "lucide-react";
import { Button } from "@/shared/components/ui/button";

// =============================================================================
// TYPES
// =============================================================================

interface WikiLinkCreatePopoverProps {
  /** Wiki-link path that doesn't resolve to an existing document */
  path: string;
  /** Display name from the wiki-link */
  displayName: string;
  /** Pixel position { top, left } relative to editor container */
  position: { top: number; left: number };
  /** Called when user confirms creation */
  onConfirm: () => void;
  /** Called when popover should close */
  onClose: () => void;
  /** Whether creation is in progress */
  isCreating: boolean;
  /** What to create — "folder" for trailing-slash wiki-links, "document" otherwise */
  refType?: "document" | "folder";
}

// =============================================================================
// COMPONENT
// =============================================================================

export function WikiLinkCreatePopover({
  path,
  displayName,
  position,
  onConfirm,
  onClose,
  isCreating,
  refType = "document",
}: WikiLinkCreatePopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  // Stable ref so event listeners never go stale even if parent re-renders
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Close on Escape and click-outside
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
      }
    }

    function handleMouseDown(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        onCloseRef.current();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    // Use capture phase so we intercept before the editor's mousedown handler
    document.addEventListener("mousedown", handleMouseDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleMouseDown, true);
    };
  }, []);

  // Extract filename from path for display
  const filename = path.split("/").pop() ?? path;
  // Show folder context if path has subdirectories
  const folderPart = path.includes("/")
    ? path.slice(0, path.lastIndexOf("/")) + "/"
    : null;

  return (
    <div
      ref={popoverRef}
      className="bg-popover text-popover-foreground border-border absolute z-50 rounded-lg border p-3 shadow-lg"
      style={{
        top: `${position.top + 8}px`,
        left: `${position.left}px`,
      }}
    >
      <div className="flex items-start gap-2">
        {refType === "folder" ? (
          <FolderPlus className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        ) : (
          <FileText className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        )}
        <div className="min-w-0">
          <p className="text-sm">
            Create {refType === "folder" ? "folder " : ""}
            <span className="font-medium">{displayName}</span>?
          </p>
          {folderPart && (
            <p className="text-muted-foreground mt-0.5 text-xs">
              in {folderPart}
            </p>
          )}
        </div>
      </div>

      <div className="mt-2.5 flex justify-end gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          disabled={isCreating}
          className="h-7 px-2.5 text-xs"
        >
          Cancel
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={onConfirm}
          disabled={isCreating}
          className="h-7 px-2.5 text-xs"
        >
          {isCreating ? (
            <>
              <Loader2 className="mr-1 size-3 animate-spin" />
              Creating...
            </>
          ) : (
            "Create"
          )}
        </Button>
      </div>

      {/* Show full filename if display name differs (e.g., wiki-link alias) */}
      {displayName !== filename && (
        <p className="text-muted-foreground mt-1.5 truncate text-xs">
          {filename}
        </p>
      )}
    </div>
  );
}
