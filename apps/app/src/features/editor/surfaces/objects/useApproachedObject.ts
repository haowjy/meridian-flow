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

import { CHROME_TIMING, EDITOR_CHROME_ATTRIBUTE } from "@/core/editor/chrome";
import {
  useChromeContext,
  useChromeSuppressed,
  useEditorChrome,
  useEditorRevision,
} from "@/features/editor/chrome";

import { type ObjectSurfaceTarget, objectSurfaceAt, objectSurfaceAtPos } from "./object-anchors";

export type ObjectApproach = {
  target: ObjectSurfaceTarget | null;
  /** Drives the fade. False with a live target means "on its way out". */
  visible: boolean;
};

/**
 * Anything a Radix layer put on the page counts as chrome the pointer is
 * allowed to travel onto: the row itself carries `data-editor-chrome`, and a
 * menu it opened lives in the popper wrapper. Without this, moving the pointer
 * from a diagram to its own ⋮ would read as leaving the diagram.
 */
const CHROME_SELECTOR = `[${EDITOR_CHROME_ATTRIBUTE}], [data-radix-popper-content-wrapper]`;

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

  useEffect(() => {
    if (!chrome) return;

    // Timing comes from the kernel, never a local timer: the kernel cancels
    // hover intent the moment a drag or a sweep starts.
    const intent = chrome.createHoverIntent<HTMLElement>({ onSettle: setHovered });

    const onPointerOver = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(CHROME_SELECTOR)) return;
      const found = objectSurfaceAt(editor.view, target);
      if (found) intent.enter(found.element);
      else intent.leave();
    };

    // On the document rather than the editor: the pointer leaves the prose
    // constantly, and only a listener that sees where it went can tell
    // "travelled onto the row" from "left the object".
    document.addEventListener("pointerover", onPointerOver, true);
    return () => {
      document.removeEventListener("pointerover", onPointerOver, true);
      intent.dispose();
    };
  }, [chrome, editor]);

  const selectedElement = selectedObjectElement(editor, context.owner, context.pos);
  const active = hovered ?? selectedElement;
  const held = useFadeHold(active, CHROME_TIMING.fadeMs);
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

/** Keep the last value for `ms` after it goes away, so a fade has something to fade. */
function useFadeHold<T>(value: T | null, ms: number): T | null {
  const [held, setHeld] = useState<T | null>(value);

  useEffect(() => {
    if (value !== null) {
      setHeld(value);
      return;
    }
    const timer = window.setTimeout(() => setHeld(null), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);

  return value ?? held;
}
