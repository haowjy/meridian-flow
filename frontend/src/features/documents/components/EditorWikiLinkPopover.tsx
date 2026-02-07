/**
 * Editor Wiki-Link Popover
 *
 * Positioned wrapper that shows the DocumentMentionPopover when the user
 * types `@` in the document editor.
 *
 * On select: parent handles insertion of `@[[path | name]]` wiki-link syntax.
 */

import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from "@floating-ui/react-dom";
import { useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import type { AtMentionState } from "@/features/threads/composer/atDetection";
import {
  DocumentMentionPopover,
  type MentionResult,
} from "@/features/threads/components/DocumentMentionPopover";

// =============================================================================
// TYPES
// =============================================================================

interface EditorWikiLinkPopoverProps {
  /** Current @-mention state from atDetection extension */
  atMention: AtMentionState | null;
  /** Pre-computed position { top, left } relative to editor container, or null */
  position: { top: number; left: number } | null;
  /** Called when user selects a document from the popover */
  onSelect: (result: MentionResult) => void;
  /** Called when popover should close */
  onClose: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function EditorWikiLinkPopover({
  atMention,
  position,
  onSelect,
  onClose,
}: EditorWikiLinkPopoverProps) {
  const isOpen = atMention?.isActive === true;
  const { refs, floatingStyles, update } = useFloating({
    open: isOpen,
    strategy: "fixed",
    placement: "top-start",
    middleware: [
      offset(8),
      flip({ fallbackPlacements: ["bottom-start"] }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  });

  useEffect(() => {
    if (!isOpen || !position) return;
    update();
  }, [isOpen, position, atMention?.query, update]);

  const setReferenceRef = useCallback(
    (node: HTMLDivElement | null) => {
      refs.setReference(node);
    },
    [refs],
  );

  const setFloatingRef = useCallback(
    (node: HTMLDivElement | null) => {
      refs.setFloating(node);
    },
    [refs],
  );

  if (!isOpen || !position) return null;

  const anchor = (
    <div
      ref={setReferenceRef}
      className="pointer-events-none absolute z-50 size-px"
      style={{
        top: `${position.top + 4}px`,
        left: `${position.left}px`,
      }}
      aria-hidden="true"
    />
  );

  if (typeof document === "undefined") {
    return anchor;
  }

  return (
    <>
      {anchor}
      {createPortal(
        <div ref={setFloatingRef} style={floatingStyles} className="z-[70]">
          <DocumentMentionPopover
            query={atMention?.query ?? ""}
            isOpen={isOpen}
            positioning="none"
            onSelect={onSelect}
            onClose={onClose}
          />
        </div>,
        document.body,
      )}
    </>
  );
}
