import { useCallback, useEffect, useRef, useState } from "react";
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from "@floating-ui/react-dom";
import type { EditorView } from "@codemirror/view";
import type { AtMentionState } from "./atDetection";

const mentionCollisionPadding = {
  top: 64,
  right: 8,
  bottom: 8,
  left: 8,
} as const;

interface MentionAnchorCoords {
  x: number;
  y: number;
}

interface UseMentionPopoverAnchorOptions {
  isOpen: boolean;
  atMention: AtMentionState | null;
  getView: () => EditorView | null;
}

/**
 * Shared mention popover positioning:
 * - derives local anchor coords from `@` trigger position
 * - wires floating-ui reference/floating refs and styles
 */
export function useMentionPopoverAnchor({
  isOpen,
  atMention,
  getView,
}: UseMentionPopoverAnchorOptions) {
  const [mentionAnchor, setMentionAnchor] =
    useState<MentionAnchorCoords | null>(null);
  const anchorContainerRef = useRef<HTMLDivElement>(null);

  const {
    refs: mentionRefs,
    floatingStyles,
    update: updateMentionPosition,
  } = useFloating({
    open: isOpen,
    strategy: "fixed",
    placement: "top-start",
    middleware: [
      offset(8),
      flip({
        fallbackPlacements: ["bottom-start"],
        padding: mentionCollisionPadding,
      }),
      shift({ padding: mentionCollisionPadding }),
    ],
    whileElementsMounted: autoUpdate,
  });

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!isOpen || !atMention) {
        setMentionAnchor(null);
        return;
      }

      const view = getView();
      const anchorContainer = anchorContainerRef.current;
      if (!view || !anchorContainer) {
        setMentionAnchor(null);
        return;
      }

      const coords = view.coordsAtPos(atMention.atPos);
      if (!coords) {
        setMentionAnchor(null);
        return;
      }

      const containerRect = anchorContainer.getBoundingClientRect();
      setMentionAnchor({
        x: coords.left - containerRect.left,
        y: coords.bottom - containerRect.top,
      });
    });

    return () => cancelAnimationFrame(frame);
  }, [isOpen, atMention, getView]);

  useEffect(() => {
    if (!isOpen || !mentionAnchor) return;
    updateMentionPosition();
  }, [isOpen, mentionAnchor, atMention?.query, updateMentionPosition]);

  const setMentionReferenceRef = useCallback(
    (node: HTMLDivElement | null) => {
      mentionRefs.setReference(node);
    },
    [mentionRefs],
  );

  const setMentionFloatingRef = useCallback(
    (node: HTMLDivElement | null) => {
      mentionRefs.setFloating(node);
    },
    [mentionRefs],
  );

  return {
    anchorContainerRef,
    mentionAnchor,
    floatingStyles,
    setMentionReferenceRef,
    setMentionFloatingRef,
  };
}
