/**
 * Which object the writer is approaching, and whether its controls show.
 *
 * Law 7's "chrome on approach" has two doors into the same state: hover
 * reveals, and selection (or a caret inside a fence) makes it persistent. One
 * hook answers both, so the diagram row, the image row, and the code chips
 * cannot disagree about who is being approached.
 *
 * `target` and `visible` are separate on purpose, and the gap between them is
 * the fade: the anchor is held for the fade's duration after the writer leaves,
 * so the row fades out over its object rather than blinking away from under
 * the pointer.
 */

import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";

import { hoverOwner } from "@/core/editor/chrome";
import {
  useChromeContext,
  useChromeSuppressed,
  useEditorChrome,
  useEditorRevision,
  useFadeHold,
} from "@/features/editor/chrome";

import { type ObjectSurfaceTarget, objectSurfaceAt, objectSurfaceAtPos } from "./object-anchors";

export type ObjectApproach = {
  target: ObjectSurfaceTarget | null;
  /** Drives the fade. False with a live target means "on its way out". */
  visible: boolean;
};

export function useApproachedObject(
  editor: Editor,
  /** Holds the current object regardless of the pointer — a menu is open on it. */
  pinned = false,
): ObjectApproach {
  const chrome = useEditorChrome(editor);
  const context = useChromeContext(editor);
  const suppressed = useChromeSuppressed(editor);
  // Chip labels read node attrs (a fence's language), so this surface follows
  // the document rather than only the resolved context.
  useEditorRevision(editor);

  const [hovered, setHovered] = useState<HTMLElement | null>(null);

  // The approach is the kernel's: it owns the timing, the pointer, and which
  // block owns chrome right now. This lane only says which object is at a
  // point. Travelling onto the row's own chrome and re-asking after a scroll
  // are both the coordinator's, so neither is answered here — and the block's
  // handle and this row settle together on the block they share, rather than
  // on two blocks that happened to settle at different moments.
  useEffect(() => {
    if (!chrome) return;
    return chrome.registerHoverAnchor<HTMLElement>({
      id: "object-approach",
      probe: ({ element }) => {
        const found = objectSurfaceAt(editor.view, element);
        if (!found) return null;
        const owner = hoverOwner(editor.view, found.element);
        return owner ? { owner, value: found.element } : null;
      },
      onSettle: setHovered,
    });
  }, [chrome, editor]);

  const selectedElement = selectedObjectElement(editor, context.owner, context.pos);
  // A remembered element dies when its node view remounts — a diagram
  // re-rendering, a peer's write rebuilding the block. Chrome is derived, never
  // remembered, so the dead one is dropped and the selection's element, which
  // is resolved from the document position on every render, answers instead.
  const active = (hovered?.isConnected ? hovered : null) ?? selectedElement;
  const held = useFadeHold(active);
  const anchor = pinned ? (active ?? held) : held;

  return {
    target: anchor ? surfaceForElement(editor, anchor) : null,
    visible: !suppressed && (pinned || active !== null),
  };
}

function selectedObjectElement(
  editor: Editor,
  owner: string,
  pos: number | null,
): HTMLElement | null {
  // `object` is a selected diagram or image; `source-block` is a caret inside a
  // plain fence, which ruling 15 gives the same persistent chip cluster.
  if (pos === null || (owner !== "object" && owner !== "source-block")) return null;
  return objectSurfaceAtPos(editor.view, pos)?.element ?? null;
}

/**
 * Re-resolve the element's position on every render rather than remembering
 * one. A position goes stale the moment anything above it changes — a peer
 * typing three paragraphs up is enough — while the element stays itself.
 */
function surfaceForElement(editor: Editor, element: HTMLElement): ObjectSurfaceTarget | null {
  if (!element.isConnected) return null;
  return objectSurfaceAt(editor.view, element);
}
