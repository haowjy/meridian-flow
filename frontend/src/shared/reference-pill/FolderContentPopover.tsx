/**
 * FolderContentPopover
 *
 * Floating popover that shows a mini folder tree when a folder pill is clicked.
 * Anchored to the pill element using @floating-ui/react-dom.
 * Click-outside or document click inside dismisses it.
 */

import { useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  useFloating,
  offset,
  flip,
  shift,
  autoUpdate,
} from "@floating-ui/react-dom";
import { useTreeStore } from "@/core/stores/useTreeStore";
import { FolderTreeView } from "@/features/threads/components/blocks/shared";
import type { Document } from "@/features/documents/types/document";

interface FolderContentPopoverProps {
  /** The folder ID whose contents to display */
  folderId: string;
  /** The DOM element to anchor the popover to (the pill) */
  anchorEl: HTMLElement;
  /** Called when the popover should close */
  onClose: () => void;
  /** Called when a document inside the tree is clicked */
  onDocumentClick: (doc: Document) => void;
}

export function FolderContentPopover({
  folderId,
  anchorEl,
  onClose,
  onDocumentClick,
}: FolderContentPopoverProps) {
  const floatingRef = useRef<HTMLDivElement>(null);

  const { floatingStyles, refs } = useFloating({
    strategy: "fixed",
    placement: "bottom-start",
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  // Set the anchor element as the floating-ui reference
  useEffect(() => {
    refs.setReference(anchorEl);
  }, [refs, anchorEl]);

  // Click-outside listener to dismiss the popover
  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      const floating = floatingRef.current;
      if (!floating) return;
      // If click is inside the popover, let it through
      if (floating.contains(e.target as Node)) return;
      onClose();
    }
    // Use capture phase + slight delay so the opening click doesn't immediately close
    const timer = setTimeout(() => {
      document.addEventListener("pointerdown", handlePointerDown, true);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [onClose]);

  // Escape key to dismiss
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  // Read tree data from store
  const folders = useTreeStore((s) => s.folders);
  const documents = useTreeStore((s) => s.documents);

  // When a document is clicked, close the popover and navigate
  const handleDocumentClick = useCallback(
    (doc: Document) => {
      onDocumentClick(doc);
      onClose();
    },
    [onDocumentClick, onClose],
  );

  // Expand the root folder by default so the user immediately sees contents
  const initialExpanded = new Set([folderId]);

  return createPortal(
    <div
      ref={(node) => {
        floatingRef.current = node;
        refs.setFloating(node);
      }}
      style={floatingStyles}
      className="bg-card border-border z-[70] max-h-64 min-w-[200px] max-w-[320px] overflow-y-auto rounded-md border p-1 shadow-md"
    >
      <FolderTreeView
        rootFolderId={folderId}
        folders={folders}
        documents={documents}
        onDocumentClick={handleDocumentClick}
        initialExpanded={initialExpanded}
      />
    </div>,
    document.body,
  );
}
