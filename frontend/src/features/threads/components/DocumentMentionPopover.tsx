/**
 * Document Mention Popover
 *
 * React-based dropdown that ranks documents/folders using fzy.js.
 * Originally built for @-mention, but also usable as a generic small popover.
 *
 * Keyboard: capture-phase handler — ArrowUp/Down navigate, Enter/Tab select, Escape closes
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { FileText, Folder } from "lucide-react";
import { useTreeStore } from "@/core/stores/useTreeStore";
import { cn } from "@/lib/utils";
import {
  rankReferenceItems,
  type ReferenceSearchItem,
} from "./documentReferenceSearch";

// =============================================================================
// TYPES
// =============================================================================

export type MentionResult = ReferenceSearchItem;

interface DocumentMentionPopoverProps {
  /** The query text after the '@' character */
  query: string;
  /** Whether the popover should be visible */
  isOpen: boolean;
  /** Positioning mode: internal absolute wrapper (default) or static content only */
  positioning?: "internal" | "none";
  /** Popover side relative to trigger point (default: above) */
  placement?: "above" | "below";
  /** Called when a document or folder is selected */
  onSelect: (result: MentionResult) => void;
  /** Called when the popover should close (Escape, click outside, etc.) */
  onClose: () => void;
}

// =============================================================================
// MENTION LIST (inner component for keyboard nav reset via key prop)
// =============================================================================

function MentionList({
  items,
  onSelect,
  onClose,
  isOpen,
}: {
  items: ReferenceSearchItem[];
  onSelect: (result: MentionResult) => void;
  onClose: () => void;
  isOpen: boolean;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const selectCurrent = useCallback(() => {
    const item = items[selectedIndex];
    if (item) {
      onSelect({
        id: item.id,
        name: item.name,
        path: item.path,
        refType: item.refType,
      });
    }
  }, [items, selectedIndex, onSelect]);

  // Capture-phase keyboard handler for navigation while popover is open
  useEffect(() => {
    if (!isOpen) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (items.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          selectCurrent();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    // Capture phase so we intercept before CM6's keymap
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [isOpen, items.length, selectCurrent, onClose]);

  // Clamp selected index to valid range
  const clampedIndex =
    items.length === 0 ? 0 : Math.min(selectedIndex, items.length - 1);

  return (
    <div className="max-h-48 overflow-y-auto py-1">
      {items.map((item, index) => (
        <button
          key={`${item.refType}-${item.id}`}
          data-mention-item
          className={cn(
            "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm",
            index === clampedIndex ? "bg-hover" : "hover:bg-hover",
          )}
          onMouseDown={(e) => {
            // Prevent editor blur
            e.preventDefault();
            onSelect({
              id: item.id,
              name: item.name,
              path: item.path,
              refType: item.refType,
            });
          }}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          {item.refType === "folder" ? (
            <Folder className="text-muted-foreground size-3.5 shrink-0" />
          ) : (
            <FileText className="text-muted-foreground size-3.5 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{item.name}</div>
            {/* Show path subtitle for docs when path differs from name, always for folders with a parent */}
            {item.path !== item.name && (
              <div className="text-muted-foreground truncate text-xs">
                {item.path}
              </div>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

/**
 * Popover showing fuzzy-matched document and folder list for @-mention in thread composer.
 * Supports keyboard navigation (ArrowUp/Down, Enter/Tab to select, Escape to close).
 *
 * Uses key={query} on MentionList to reset selection when the query changes.
 */
export function DocumentMentionPopover({
  query,
  isOpen,
  positioning = "internal",
  placement = "above",
  onSelect,
  onClose,
}: DocumentMentionPopoverProps) {
  const documents = useTreeStore((s) => s.documents);
  const folders = useTreeStore((s) => s.folders);

  // Fuzzy-rank documents + folders
  const items = useMemo(
    () => rankReferenceItems(query, documents, folders),
    [query, documents, folders],
  );

  if (!isOpen || items.length === 0) return null;

  return (
    <div
      data-document-mention-popover="true"
      className={cn(
        "bg-popover text-popover-foreground w-72 overflow-hidden rounded-md border shadow-md",
        positioning === "internal" &&
          "absolute left-0 z-50 " +
            (placement === "above" ? "bottom-full mb-1" : "top-full mt-1"),
      )}
    >
      {/* key={query} remounts MentionList on query change, resetting selectedIndex */}
      <MentionList
        key={query}
        items={items}
        onSelect={onSelect}
        onClose={onClose}
        isOpen={isOpen}
      />
    </div>
  );
}
