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
  visible: boolean;
};

export function useApproachedObject(editor: Editor, pinned = false): ObjectApproach {
  const chrome = useEditorChrome(editor);
  const context = useChromeContext(editor);
  const suppressed = useChromeSuppressed(editor);
  const revision = useEditorRevision(editor);

  const [hovered, holdHovered] = useNodeHold(editor);
  const [selected, holdSelected] = useNodeHold(editor);

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

  const selectedPos =
    context.owner === "object" || context.owner === "source-block" ? context.pos : null;
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
