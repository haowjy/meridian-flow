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
 *
 * Both doors settle on a `NodeHold`, never on the element the pointer hit.
 * Elements are geometry: an element is how the pointer names an object and how
 * the row is measured, and a remote write replaces it while the writer is still
 * looking at the same diagram. So what this hook carries between frames is the
 * object, and DOM is resolved from it on every read.
 */

import type { Editor } from "@tiptap/core";
import { useEffect } from "react";

import { hoverOwner } from "@/core/editor/chrome";
import {
  useChromeContext,
  useChromeSuppressed,
  useEditorChrome,
  useEditorRevision,
  useFadeHold,
  useNodeHold,
} from "@/features/editor/chrome";

import { type ObjectSurfaceTarget, objectSurfaceAt, objectSurfaceForHold } from "./object-anchors";

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
  const revision = useEditorRevision(editor);

  const [hovered, holdHovered] = useNodeHold(editor);
  const [selected, holdSelected] = useNodeHold(editor);

  // The approach is the kernel's: it owns the timing, the pointer, and which
  // block owns chrome right now. This lane only says which object is at a
  // point. Travelling onto the row's own chrome and re-asking after a scroll
  // are both the coordinator's, so neither is answered here — and the block's
  // handle and this row settle together on the block they share, rather than
  // on two blocks that happened to settle at different moments.
  useEffect(() => {
    if (!chrome) return;
    return chrome.registerHoverAnchor<number>({
      id: "object-approach",
      probe: ({ element }) => {
        const found = objectSurfaceAt(editor.view, element);
        if (!found) return null;
        const owner = hoverOwner(editor.view, found.element);
        return owner ? { owner, value: found.pos } : null;
      },
      onSettle: holdHovered,
    });
  }, [chrome, editor, holdHovered]);

  // `object` is a selected diagram or image; `source-block` is a caret inside a
  // plain fence, which ruling 15 gives the same persistent chip cluster.
  const selectedPos =
    context.owner === "object" || context.owner === "source-block" ? context.pos : null;
  // Re-taken on every change rather than remembered: the selection is the
  // document's own state, and the kernel keeps its position current. What makes
  // it a hold at all is what outlives it — the fade, and a menu pinned open on
  // an object the writer has since stopped pointing at.
  useEffect(() => {
    holdSelected(selectedPos);
  }, [holdSelected, selectedPos, revision]);

  const active = hovered ?? selected;
  const held = useFadeHold(active);
  const anchor = pinned ? (active ?? held) : held;

  return {
    target: objectSurfaceForHold(editor.view, anchor),
    visible: !suppressed && (pinned || active !== null),
  };
}
